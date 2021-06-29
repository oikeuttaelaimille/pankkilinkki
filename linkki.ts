import { Handler, SQSEvent, ScheduledEvent } from "aws-lambda";

import * as S3 from "aws-sdk/clients/s3";
import * as SQS from "aws-sdk/clients/sqs";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import fetch from "node-fetch";

import { Osuuspankki, Key } from "pankkiyhteys";

const {
  BUCKET,
  QUEUE,
  USERNAME,
  SLACK_WEBHOOK_INFO,
  SLACK_WEBHOOK_LOGS,
  LANGUAGE = "EN" as any,
  ENVIRONMENT = undefined as any,
} = process.env;

const TMP_PATH = path.join(os.tmpdir(), "pankkilinkki");

// Ensure cache directory exists.
if (!fs.existsSync(TMP_PATH)) {
  fs.mkdirSync(TMP_PATH);
}

const s3 = new S3({
  apiVersion: "2006-03-01",
  params: { Bucket: BUCKET },
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
          ResponseContentEncoding: "",
        })
        .promise()
        .then(({ Body }) => {
          if (Body instanceof Buffer) {
            // Cache file to local filesystem later.
            setImmediate(() =>
              fs.writeFile(filePath, Body, (err) => {
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
  DownloadFile,
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
  // folder name = when file was downloaded.
  const date = new Date();
  const twoDigitMonth = ("0" + (date.getMonth() + 1)).slice(-2);
  const dateFolder = `${date.getFullYear()}-${twoDigitMonth}`;

  return `files/${dateFolder}/${userFilename}.${type.toLocaleLowerCase()}`;
}

async function getKeys() {
  let keyFiles = await Promise.all(
    ["privkey.pem", "certificate.pem"].map((file) => readFile(file))
  );

  return keyFiles.map((item) => item.toString());
}

function* getFileChunk(arr: FileDescriptor[], types: string[], chunkSize = 10) {
  let files = arr.filter((item) => types.includes(item.FileType));

  for (let i = 0; i < files.length; i += chunkSize) {
    yield files.slice(i, i + chunkSize);
  }
}

async function postSlackMessage(message: any, channel: "logs" | "info") {
  const hook = channel === "logs" ? SLACK_WEBHOOK_LOGS : SLACK_WEBHOOK_INFO;

  if (hook) {
    return fetch(hook, {
      method: "post",
      body: JSON.stringify(message),
      headers: { "Content-Type": "application/json" },
    })
      .then((res: any) => res.json())
      .then((json: any) => console.log(json))
      .catch((response: any) => console.log(response));
  }
}

function isAboutToExpire(key: Key) {
  const dateToCheck = new Date();
  dateToCheck.setMonth(dateToCheck.getMonth() + 2);
  return key.expires() < dateToCheck;
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
          Body: content,
        })
        .promise();
    }
  } else if (isScheduledEvent(event)) {
    console.log(event);

    if (event.resources.some((element) => element.endsWith("key-check"))) {
      if (isAboutToExpire(key)) {
        await postSlackMessage(
          {
            blocks: [
              {
                type: "header",
                text: {
                  type: "plain_text",
                  text: "Pankkilinkki avain on vanhenemassa ⚠️",
                  emoji: true,
                },
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `> Avain vanhenee ${key
                    .expires()
                    .toLocaleString("fi-FI")}`,
                },
              },
            ],
          },
          "info"
        );
      } else {
        await postSlackMessage(
          {
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `Pankkilinkki avain vanhenee ${key
                    .expires()
                    .toLocaleString("fi-FI")}`,
                },
              },
            ],
          },
          "logs"
        );
      }
    }

    if (event.resources.some((element) => element.endsWith("poll"))) {
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

      console.log(`Fetching list of files`);

      const files: FileDescriptor[] = await client.getFileList({
        Status: "NEW",
      });

      console.log(`Found ${files.length} files`);

      const batchRequests = [];

      for (const chunk of getFileChunk(files, ["INFO", "RI", "TL", "XI"])) {
        console.log(`Scheduling ${chunk.length} items`);

        const batch = chunk.map((item) => ({
          type: TaskType.DownloadFile,
          payload: item,
        }));

        const requests = sqs
          .sendMessageBatch({
            QueueUrl: queueUrl,
            Entries: batch.map((message, index) => ({
              MessageBody: JSON.stringify(message),
              Id: index.toString(),
            })),
          })
          .promise();

        batchRequests.push(requests);
      }

      await Promise.all(batchRequests);
    }
  } else {
    throw new Error(`Unrecognized event ${JSON.stringify(event)}`);
  }
};
