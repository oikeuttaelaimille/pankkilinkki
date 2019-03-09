import simplejson as json
import os
import requests
import boto3
from collections import namedtuple
from datetime import datetime
from decimal import Decimal
from enum import Enum
from pathlib import Path
from io import StringIO


class Rahayksikko(Enum):
    EURO = 1


class Tila(Enum):
    ONNISTUNUT = 0
    TILIA_EI_LOYDY = 1
    KATE_EI_RIITA = 2
    EI_MAKSUPALVELUTILI = 3
    MAKSAJA_PERUUTTANUT = 4
    PANKKI_PERUUTTANUT = 5
    PERUUTUS_EI_KOHDISTU = 6
    VALTUUTUS_PUUTTUU = 7
    ERAPAIVAVIRHE = 8
    MUOTOVIRHE = 9


class TapahtumaLuettelo:
    Row = namedtuple(
        "Row",
        [
            "tilinumero",
            "kirjauspv",
            "maksupv",
            "arkistointitunnus",
            "viite",
            "nimi",
            "rahayksikko",
            "nimen_lahde",
            "summa",
            "oikaisutunnus",
            "valitystapa",
            "tila",
        ],
    )

    @classmethod
    def parse(cls, content):
        with StringIO(content) as buffer:
            return cls(buffer)

    def _to_decimal(self, field):
        return Decimal("{}.{}".format(field[:-2], field[-2:]))

    def _read_footer(self, footer):
        self.viitetap_kpl += int(footer[1:7])
        self.viitetap_summa += self._to_decimal(footer[7:18])
        self.viiteoik_kpl += int(footer[18:24])
        self.viiteoik_summa += self._to_decimal(footer[24:35])
        self.epaonnis_kpl += int(footer[35:41])
        self.epaonnis_summa += self._to_decimal(footer[41:52])

    def _read_header(self, header):
        self.kirjoituspv = datetime.strptime(header[1:11], "%y%m%d%H%M")

    def _read_row(self, line):
        self._rows.append(
            self.Row(
                tilinumero=line[1:15],
                kirjauspv=datetime.strptime(line[15:21], "%y%m%d").date(),
                maksupv=datetime.strptime(line[21:27], "%y%m%d").date(),
                arkistointitunnus=line[27:43],
                viite=line[43:63].lstrip("0"),
                nimi=line[63:75].replace("[", "Ä").replace("\\", "Ö").rstrip(),
                rahayksikko=Rahayksikko(int(line[75:76])),
                nimen_lahde=line[76:77],
                summa=self._to_decimal(line[77:87]),
                oikaisutunnus=int(line[87:88]),
                valitystapa=line[88:89],
                tila=Tila(int(line[89:90].strip() or 0)),
            ))

    def __init__(self, buffer):
        self._rows = []
        self.viitetap_kpl = 0
        self.viiteoik_kpl = 0
        self.epaonnis_kpl = 0
        self.viitetap_summa = Decimal(0)
        self.viiteoik_summa = Decimal(0)
        self.epaonnis_summa = Decimal(0)

        for line in buffer.readlines():
            # Skip empty lines
            if not line.strip():
                continue
            # Check header magic
            elif line[0] == "0":
                self._read_header(line)
            # Footer magic
            elif line[0] == "9":
                self._read_footer(line)
            else:
                self._read_row(line)

    def __getitem__(self, index):
        return self._rows[index]

    def __iter__(self):
        return iter(self._rows)

    def __len__(self):
        return len(self._rows)


ENDPOINT = os.environ['ENDPOINT']
API_KEY = os.environ['API_KEY']


def is_s3_event(event) -> bool:
    return 'Records' in event and all('s3' in r for r in event['Records'])


def handle_info(data):
    print(data.decode('utf-8'))


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
