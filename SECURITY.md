# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub:
**Security → Report a vulnerability** on this repository
(GitHub private vulnerability reporting). Do not open a public issue.

Include, when possible:

- the component (`contracts/organization`, `contracts/factory`, `packages/core`),
- the commit you reviewed,
- a proof of concept (a failing Rust test or a Node test is ideal),
- the impact you expect (funds at risk, denial of service, incorrect payouts…).

We aim to acknowledge reports within 3 business days and to publish a fix,
or a documented mitigation, before any public disclosure.

## Scope

| In scope | Out of scope |
|---|---|
| Soroban contracts in `contracts/` | The host warehouse system (FMS) that feeds activity data |
| The off-chain engine in `packages/core` | Wallet software (Freighter, etc.) |
| Documentation that describes security properties | Stellar Asset Contract, Horizon, Soroban RPC |

Known issues are listed in [docs/audit/findings.md](docs/audit/findings.md);
reports that only restate them are welcome as extra evidence but are not new findings.

## Keys

This repository must never contain secret keys. Contract tests use generated
addresses; Node tests generate random keypairs at run time. If you find a
secret key in the history, report it through the channel above.
