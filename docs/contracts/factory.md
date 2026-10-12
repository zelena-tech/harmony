# Factory contract — reference

Source: [`contracts/factory/src/lib.rs`](../../contracts/factory/src/lib.rs)
(soroban-sdk 21.7.7).

The Factory is a **registry** of organization contracts (`org_id → address`).
It does not deploy contracts, holds no funds and has no authority over the
organizations it lists.

## Storage

| Key | Storage | Value |
|---|---|---|
| `Admin` | instance | `Address` |
| `OrgCount` | instance | `u64` |
| `Org(u64)` | persistent (TTL 365 days at creation) | `Address` |

## Entry points

| Function | Auth | Preconditions | Effects | Event |
|---|---|---|---|---|
| `initialize(admin)` | admin | not initialized | Admin = admin, OrgCount = 0 | `factory_init` |
| `register_org(org_address)` | Admin | — | OrgCount += 1; Org(id) = org_address; returns id | `org_registered` |
| `get_org(org_id)` | — | exists | returns the address | |
| `get_org_count()` | — | | | |
| `get_admin()` | — | initialized | | |
| `transfer_admin(new_admin)` | Admin and new_admin | — | Admin = new_admin | `admin_transferred` |

## Errors

| Code | Name |
|---|---|
| 1 | AlreadyInitialized |
| 2 | NotInitialized |
| 3 | Unauthorized (declared, not used) |
| 4 | OrgNotFound |
| 5 | Overflow |

## Notes for integrators

- `register_org` accepts any address, accepts duplicates and never checks
  that the address runs the organization wasm (HMY-09). Before trusting an
  entry, verify the wasm hash of the registered contract
  (`stellar contract fetch --id <address>` and compare with the published hash).
- There is no way to remove an entry.
- `initialize` can be front-run between deploy and initialization (HMY-16).
