import { Handler, SQSEvent, ScheduledEvent } from "aws-lambda";

import * as S3 from "aws-sdk/clients/s3";
import * as SQS from "aws-sdk/clients/sqs";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { Osuuspankki, Key } from "pankkiyhteys";

const {
  BUCKET,
  QUEUE,
  USERNAME,
  LANGUAGE = "EN" as any,
  ENVIRONMENT = undefined as any
} = process.env;

const TMP_PATH = path.join(os.tmpdir(), "pankkilinkki");

// Ensure cache directory exists.
if (!fs.existsSync(TMP_PATH)) {
  fs.mkdirSync(TMP_PATH);
}

const s3 = new S3({
  apiVersion: "2006-03-01",
  params: { Bucket: BUCKET }
});

const sqs = new SQS();

/**
 * Asynchronously reads the entire contents of a file.
 */
function readFile(fileName: string) {
  return new Promise<Buffer>((resolve, reject) => {
    const filePath = path.join(TMP_PATH, fileName);

    fs.readFile(filePath, (err, data) => {
      if (!err) {
        return resolve(data);
      }

      console.log(`Downloading ${fileName} from s3://${BUCKET} to ${filePath}`);

      return s3
        .getObject({
          Bucket: BUCKET!,
          Key: fileName,
          ResponseContentEncoding: ""
        })
        .promise()
        .then(({ Body }) => {
          if (Body instanceof Buffer) {
            // Cache file to local filesystem later.
            setImmediate(() =>
              fs.writeFile(filePath, Body, err => {
                if (err) {
                  console.warn(`Failed to cache ${fileName}`, err);
                }
              })
            );

            return resolve(Body);
          }

          return reject(new Error(`Failed to download ${fileName}`));
        });
    });
  });
}

interface FileDescriptor {
  FileReference: number;
  TargetId: string;
  UserFilename: string;
  ParentFileReference: number;
  FileType: string;
  FileTimestamp: string;
  Status: string;
}

const enum TaskType {
  DownloadFile
}

interface TaskInfo {
  type: TaskType;
  payload: FileDescriptor;
}

function isSQSEvent(event: any): event is SQSEvent {
  return Array.isArray(event.Records);
}

function isScheduledEvent(event: any): event is ScheduledEvent {
  return event["detail-type"] !== undefined;
}

function makeFileKey(userFilename: string, type: string) {
  const date = new Date();
  const twoDigitMonth = ("0" + (date.getMonth() + 1)).slice(-2);
  const dateFolder = `${date.getFullYear()}-${twoDigitMonth}`;

  return `files/${dateFolder}/${userFilename}.${type.toLocaleLowerCase()}`;
}

async function getKeys() {
  let keyFiles = await Promise.all(
    ["privkey.pem", "certificate.pem"].map(file => readFile(file))
  );

  return keyFiles.map(item => item.toString());
}

export const handler: Handler<SQSEvent | ScheduledEvent, void> = async (
  event,
  context
) => {
  console.log(event);

  // Load certificate and private key
  const [privkey, certificate] = await getKeys();

  const key = new Key(privkey, certificate);
  const client = new Osuuspankki(USERNAME!, key, LANGUAGE, ENVIRONMENT);

  // Route based on event type.
  if (isSQSEvent(event)) {
    // Download files to s3.
    for (const { body } of event.Records) {
      const { payload } = JSON.parse(body) as TaskInfo;

      // File timestamp in file name?

      const key = makeFileKey(payload.UserFilename, payload.FileType);
      const content = await client.getFile(payload.FileReference.toString());

      console.log(`Copying file to ${key}`);

      await s3
        .putObject({
          Key: key,
          Bucket: BUCKET!,
          Body: content
        })
        .promise();
    }
  } else if (isScheduledEvent(event)) {
    console.log("Fetching list of new files");

    // Enqueue files for download.
    const queueUrl = await sqs
      .getQueueUrl({ QueueName: QUEUE! })
      .promise()
      .then(({ QueueUrl }) => {
        if (!QueueUrl) {
          throw new Error(`Error getting queue url for sqs://${QUEUE}`);
        }

        return QueueUrl;
      });

    const chunkSize = 10;
    const batchRequests = [];
    const files: FileDescriptor[] = await client.getFileList({
      FileType: "TL",
      Status: "NEW"
    });

    console.log(`Found ${files.length} files`);

    for (let i = 0; i < files.length; i += chunkSize) {
      const chunk: TaskInfo[] = files.slice(i, i + chunkSize).map(item => ({
        type: TaskType.DownloadFile,
        payload: item
      }));

      const requests = sqs
        .sendMessageBatch({
          QueueUrl: queueUrl,
          Entries: chunk.map((item, index) => ({
            MessageBody: JSON.stringify(item),
            Id: index.toString()
          }))
        })
        .promise();

      console.log(`Queueing download for ${chunk.length} files`);

      batchRequests.push(requests);
    }

    await Promise.all(batchRequests);
  } else {
    throw new Error(`Unrecognized event ${JSON.stringify(event)}`);
  }
};
