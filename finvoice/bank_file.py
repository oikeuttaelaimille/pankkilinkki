import xmltodict
import logging

from lxml import etree

logger = logging.getLogger(__name__)


class Envelope:
    NSMAP = {
        'SOAP-ENV': 'http://schemas.xmlsoap.org/soap/envelope/',
        'eb': 'http://www.oasis-open.org/committees/ebxml-msg/schema/msg-header-2_0.xsd'
    }

    class Header:
        def __init__(self, route, MessageId, Timestamp, Service=None, Action=None):
            self.route = route
            self.service = Service,
            self.action = Action,
            self.message_id = MessageId
            self.timestamp = Timestamp

    def __init__(self, header):
        self.header = header

    @classmethod
    def parse(cls, xml):
        """Parse xml element or string to Envelope object

        Returns:
            Envelope object.

        Raises:
            ValueError: If parsing fails.
        """
        # Support string or bytes input
        if isinstance(xml, str) or isinstance(xml, bytes):
            xml = etree.fromstring(xml)

        # Unpack list of results: expect exactly one result.
        (message_header, ) = xml.xpath('/SOAP-ENV:Envelope/SOAP-ENV:Header/eb:MessageHeader', namespaces=cls.NSMAP)

        # Parse route
        route = {}
        for element in message_header.xpath('./eb:From|./eb:To', namespaces=cls.NSMAP):
            route.setdefault(etree.QName(element).localname, []).append({
                etree.QName(x).localname: x.text
                for x in element.xpath('./eb:PartyId|./eb:Role', namespaces=cls.NSMAP)
            })

        return cls(header=cls.Header(route=route,
                                     **{
                                         etree.QName(x).localname: x.text
                                         for x in message_header.xpath('|'.join(('./eb:Action', './eb:Service',
                                                                                 './eb:MessageData/eb:MessageId',
                                                                                 './eb:MessageData/eb:Timestamp')),
                                                                       namespaces=cls.NSMAP)
                                     }))


def parse_document(body):
    return xmltodict.parse(body)


def parse(body):
    """Parse XML files sent by bank

    Why bank, why! Why are the xml files concatenated. (ಠ_ಠ)
    """

    parser = etree.XMLPullParser(events=('start', 'end'))

    envelope = None
    root_tag = None

    for line in body.splitlines():
        parser.feed(line)

        for action, element in parser.read_events():
            if root_tag is None and action == 'start':
                root_tag = etree.QName(element)

            elif action == 'end' and element.tag == root_tag:
                tag = root_tag
                root_tag = None
                root = parser.close()

                if tag.localname == 'Envelope':
                    envelope = Envelope.parse(root)
                elif tag.localname == 'Finvoice':
                    if envelope is not None:
                        yield root, envelope
                    else:
                        yield root
                else:
                    document = parse_document(etree.tostring(root))
                    if envelope is not None:
                        document['Envelope'] = envelope
                        envelope = None

                    yield document

    # Didn't find closing tag for last document.
    if root_tag is not None:
        raise ValueError('Junk after last document')
