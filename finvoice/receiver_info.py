def make_receiver_info_message(document):
    envelope = document['Envelope']
    receiver_info = document['FinvoiceReceiverInfo']
    recipient_details = receiver_info['InvoiceRecipientDetails']

    res = {
        'id': envelope.header.message_id,
        'action_code': receiver_info['MessageDetails']['MessageActionCode'].upper(),
        'timestamp': receiver_info['ReceiverInfoTimeStamp'],
        'recipient_address': recipient_details['InvoiceRecipientAddress'],
        'recipient_intermediator': recipient_details['InvoiceRecipientIntermediatorAddress'],
        'recipient_identifier': recipient_details['SellerInvoiceIdentifier'],
        'recipient_name': receiver_info['BuyerPartyDetails']['BuyerOrganisationName'].title(),
        'proposed_due_date': receiver_info.get('ProposedDueDate', None)
    }

    if 'BuyerServiceCode' in receiver_info:
        res['service_code'] = int(receiver_info['BuyerServiceCode'])
    else:
        # Version 1.0 does not support service codes.
        res['service_code'] = 0

    return res
