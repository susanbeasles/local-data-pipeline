"""Conservative padded KV reservations; no model code, data or network access."""
def footprint(lengths, bytes_per_token, block=256):
    if not lengths:
        return 0
    return ((max(lengths)+block-1)//block)*block*len(lengths)*bytes_per_token

def allows(lengths, candidate, bytes_per_token, budget, capacity):
    if candidate < 1 or bytes_per_token < 1 or budget < 1 or capacity < 1:
        raise ValueError('invalid inference memory reservation')
    return len(lengths)<capacity and footprint([*lengths,candidate],bytes_per_token)<=budget
