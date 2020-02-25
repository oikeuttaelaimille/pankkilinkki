import boto3
import simplejson as json
import os
import requests
from pathlib import Path

from finvoice.tapahtumaluettelo import TapahtumaLuettelo

STAGE = os.environ.get('STAGE', default='dev')
ENDPOINT = os.environ['ENDPOINT']
API_KEY = os.environ['API_KEY']
SLACK_WEBHOOK_LOGS = os.environ['SLACK_WEBHOOK_LOGS']
SLACK_WEBHOOK_INFO = os.environ['SLACK_WEBHOOK_INFO']

WINDOWS_LINE_ENDING = b'\r\n'
UNIX_LINE_ENDING = b'\n'


def is_s3_event(event) -> bool:
    return 'Records' in event and all('s3' in r for r in event['Records'])


def handle_info(data):
    MESSAGE_MAX_LENGHT = 3000

    header, _, body = data.replace(WINDOWS_LINE_ENDING, UNIX_LINE_ENDING).decode('utf-8').partition("\n")

    # Sometimes bank messages have translations separated by newlines.
    body_first, _, _ = body.partition('\n\n\n')

    # Max length
    if len(body_first) > MESSAGE_MAX_LENGHT:
        body_first = (body_first[:(MESSAGE_MAX_LENGHT - 3)] + '...')

    print(header + "\n" + body)

    message = {
        "blocks": [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": '*Viesti pankilta: ' + header + '*'
                }
            },
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": body_first
                }
            },
            {
                "type": "context",
                "elements": [
                    {
                        "type": "mrkdwn",
                        "text": f"pankkilinkki-{STAGE}"
                    }
                ]
            }
        ]
    }

    r = requests.post(SLACK_WEBHOOK_INFO, json=message)

    print(r.status_code)


def handle_tl(data):
    events = TapahtumaLuettelo.parse(data.decode('ascii'))

    payload = {
        'payments': [{
            'closeDate': event.maksupv.isoformat(),
            'archiveId': event.arkistointitunnus,
            'referenceNumber': event.viite,
            'amount': event.summa
        } for event in events]
    }

    r = requests.post(f'{ENDPOINT}/rekisteri/payment',
                      headers={
                          'API-Key': API_KEY,
                          'Content-Type': 'application/json'
                      },
                      data=json.dumps(payload))

    # Raise exception if error occured.
    r.raise_for_status()

    res = r.json()
    res = res['records'] if 'records' in res else 0

    print(f'Modified {res} records')


def handle_xi(data):
    raise Exception('Not implemented yet')


def handle_ri(data):
    raise Exception('Not implemented yet')
    """
    payload = {
        'payments': [{
            'closeDate': event.maksupv.isoformat(),
            'archiveId': event.arkistointitunnus,
            'referenceNumber': event.viite,
            'amount': event.summa
        } for event in events]
    }

    r = requests.post(f'{ENDPOINT}/rekisteri/payment?action=finvoice',
                      headers={
                          'API-Key': API_KEY,
                          'Content-Type': 'application/json'
                      },
                      data=json.dumps(payload))

    # Raise exception if error occured.
    r.raise_for_status()

    res = r.json()
    res = res['records'] if 'records' in res else 0

    print(f'Modified {res} records')
    """


def handler(event, context):
    print(event)

    # Validate event object
    if not is_s3_event(event):
        raise Exception('Invalid event')

    s3 = boto3.client('s3')

    file_handlers = {
        'INFO': handle_info,
        'TL': handle_tl,
        'XI': handle_xi,
        'RI': handle_ri
    }

    for record in event['Records']:
        bucket = record['s3']['bucket']['name']
        key = record['s3']['object']['key']
        file_type = Path(key).suffix.upper().lstrip('.')

        if file_type not in file_handlers:
            raise Exception(f'"{file_type}" file type is not recognized')

        print(f'Downloading s3://{bucket}/{key}')
        response = s3.get_object(Bucket=bucket, Key=key)
        body = response['Body'].read()

        print(f'Processing {key}')
        file_handlers[file_type](body)


def main():
    parser = argparse.ArgumentParser("simple_example")
    parser.add_argument(
        "--path",
        help=(
            "The path to a json file holding input data to be passed to the " +
            "invoked function as the event."
        ),
        type=argparse.FileType('r'))
    args = parser.parse_args()
    print(args)

    data = json.loads(args.path.read())

    handler(data, False)


if __name__ == '__main__':
    import argparse

    main()
