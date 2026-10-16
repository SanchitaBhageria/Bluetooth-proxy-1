# ProxyProof – Bluetooth Attendance

Attendance that marks students automatically when they are physically in the room, and makes proxy attendance very hard.

**Live demo:** https://anamikasharma23.github.io/proxyproof/

## How it works
1. The organiser's phone broadcasts a BLE-style advertisement (no pairing) carrying a **session ID** and a **token that rotates every 5 seconds** (HMAC-SHA256 of the session secret + time window).
2. A student's phone picks up the signal and sends session ID, token, student ID, device ID and RSSI to the server.
3. The server marks attendance **only if** the student is registered, the token is fresh, the request comes from the student's registered device, and the RSSI is −75 dBm or stronger.

## Core requirements covered
| Requirement | Where |
|---|---|
| Organiser / Student login, one device per student, switching needs approval | `Server.register`, `Server.login`, `Server.decideDevice` |
| Session broadcasts for a fixed duration | `Server.startSession`, `startBroadcast` |
| Nearby students marked automatically | `Radio.onScan` handler |
| Rotating tokens defeat shared/replayed codes; one device marks one student | `Server.token`, `Server.mark` |
| Live dashboard with manual add/remove and session close | `refreshOrg` |
| Student history + percentage, CSV export for organisers | `refreshStu`, `Server.csv` |

## Architecture
- **Server** – all verification logic. In this prototype it runs in the browser and stores data in `localStorage`.
- **Radio** – the BLE layer. Browsers can't broadcast BLE, so the web demo carries advertisements between tabs using `BroadcastChannel`, and RSSI comes from a distance slider (log-distance path-loss model, −59 dBm at 1 m).
- **UI** – organiser and student views.

To ship as a real mobile app, replace `Radio.advertise` / `Radio.onScan` with a native BLE advertiser/scanner (e.g. React Native + `react-native-ble-advertiser` / `react-native-ble-plx`) and move `Server` to a real backend (Firebase / Supabase / Node). The token and verification logic stay the same.

## How to test
Open the demo in **one browser, several normal tabs** (each tab acts as a separate phone). Open new tabs with Ctrl+T and paste the link; don't use "Duplicate tab" or incognito.

1. **Tab A:** create an Organiser account, log in, start a session.
2. **Tab B:** create a Student account, log in. Within a few seconds it's marked present and Tab A's dashboard updates.
3. **Distance:** in another student tab, drag the slider beyond ~6 m – it's rejected as too far; move closer – it gets marked.
4. **Replay / fake token / proxy:** use the "Try to cheat" buttons – all rejected.
5. **Device switch:** in a new tab click "Switch to a new phone" and log in as an existing student – a request appears for the organiser to approve.
6. **Manual edit, close, CSV:** use Add/Remove, Close session and Export CSV on the organiser tab.
