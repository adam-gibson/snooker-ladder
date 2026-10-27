# Patteson Social Club Snooker Ladder

A free web app for the club snooker ladder.

- **Website** (this repository) is hosted on GitHub Pages.
- **Data** is stored in a Google Sheet, which a Google Apps Script (`apps-script/Code.gs`) reads and updates. The script keeps the PINs private and applies the 240-hour rule every hour.

## Setting up (about 10 minutes, one time only)

### 1. Google Sheet and script
1. Go to <https://sheets.new> and name the sheet **Snooker Ladder**.
2. Open **Extensions > Apps Script**. Delete the code that is there and paste in the whole of `apps-script/Code.gs`. Save.
3. Optional: type your own admin PIN between the quotes in `const ADMIN_PIN = '';`.
4. Choose **setup** from the function drop-down and click **Run**. Allow the permissions it asks for (if you see "Google hasn't verified this app", click *Advanced > Go to … (unsafe)*: it is your own script).
5. Back in the sheet you will see these tabs:
   - **Players:** each player's PIN and alert topic
   - **Settings:** includes `adminPin`
   - **Challenges**
   - **Log**
6. In Apps Script, click **Deploy > New deployment**, choose the cog and pick **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).

### 2. Website
1. In this repository, edit `config.js` and paste the web app URL between the quotes.
2. Go to **Settings > Pages**. Under *Build and deployment*, choose *Deploy from a branch*, then **main** and **/ (root)**. Save.
3. After a minute or two the site will be at `https://<your-username>.github.io/<repository-name>/`.
4. Open the site, go to **Admin** at the bottom of the page and log in with the admin PIN. Under *Settings*, check the site address is right and save. Then add players' mobile numbers using **Edit**.

### Updating the script later
Paste the new code in Apps Script, then go to **Deploy > Manage deployments**. Click the pencil, choose **Version: New version** and click **Deploy**. Doing it this way keeps the URL the same.

## Telling players their PIN and alert topic
Send each player a private WhatsApp message with:
- their 4-digit **PIN** (they can change it on the site with *Change my PIN*)
- their **alert topic** (optional, for free phone alerts)

**Phone alerts:** install the free **ntfy** app (Android or iPhone), tap **+** and enter the topic exactly as given. The player then gets an alert when:
- they are challenged
- a match is booked
- a result needs confirming
- a deadline passes

## How it works
- Anyone can view the ladder. A PIN is needed only to challenge, book a date, enter a result or confirm a result.
- Players in a challenge are shown in amber. A player can only be in one challenge at a time.
- Bookings after the 240-hour deadline are refused.
- When the deadline passes without a result, the challenger is awarded the win automatically. This happens on the hourly check or as soon as anyone opens the site.
- Either player enters the score. The opponent confirms or disputes it. If they do neither, it is confirmed after 24 hours. Disputed results are decided by the admin.
- Ladder moves are worked out from players' current positions when the result is applied. If other results have shifted players in the meantime, the challenger still takes the defender's place, and everyone between them drops one.
- New challenges stop when there are fewer than 240 hours left in the season.

## Admin can
- Add a player, with their position
- Edit a player's name, mobile or alert topic
- Move a player
- Remove a player (everyone below moves up)
- Issue a new PIN
- Add a challenge manually with a past start time
- Set a result or cancel a challenge
- Start a new season with a random draw
- See the activity log
