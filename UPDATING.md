# UPDATING - install a new version into the owner's CURRENT folder

*For the assistant (the owner can read along). Use this when the owner says something like
"Let's get updated. The new version is in my Downloads. Keep all my info." - or "update my
Machine", "install the update", or drags the new zip into the chat.*

**The golden rule:** the owner's Machine folder stays exactly where it is. Never move, rename or
re-create it, never make a second copy, and never touch their `.env`, `client-config.md` or
`system/.state/` by hand. The update script replaces only the program files and keeps a backup.

Work from the owner's CURRENT Machine folder (the one open in the Code tab - it has their `.env`
and `client-config.md`). Below, `<machine>` means that folder's full path.

## 1. Find the new version

In this order:

1. A path the owner attached, dragged in, or typed.
2. Otherwise the newest `AI Freedom Machine - Auto-Pilot*.zip` in their Downloads folder
   (`~/Downloads` on a Mac, `%USERPROFILE%\Downloads` on Windows).
3. Otherwise an already-unzipped `AI Freedom Machine - Auto-Pilot` folder in Downloads. (Safari on
   a Mac unzips downloads by itself and puts the .zip in the Trash - that's normal.)

On a Mac the first look in Downloads may make the Claude app ask **"Claude would like to access
files in your Downloads folder"** - tell the owner to click **Allow**.

If you find the **Co-Pilot** download instead (`AI Freedom Machine - Co-Pilot`), stop: that's the
other edition. Ask them for the Auto-Pilot download (it's in the same email).

If nothing is there, ask them to download the Auto-Pilot version from their update email, then
look again.

## 2. Unzip it into a temporary folder (skip if it's already a folder)

Make an empty temporary folder OUTSIDE the Machine folder, then extract with `tar`, which ships
with Windows 10+ and macOS and handles long paths (don't use Expand-Archive - it fails on long
paths):

- Mac: `mkdir -p "$TMPDIR/aifm-update" && tar -xf "<zip>" -C "$TMPDIR/aifm-update"`
- Windows (PowerShell): `New-Item -ItemType Directory -Force "$env:TEMP\aifm-update"` then
  `tar -xf "<zip>" -C "$env:TEMP\aifm-update"`

The new version is then `<tmp>/AI Freedom Machine - Auto-Pilot`. Call that `<new>`. (If you
already have an unzipped folder, `<new>` is that folder.)

## 3. Preview (changes nothing)

    node "<new>/system/update.js" --into "<machine>" --dry-run

Mac: if `node` isn't found, use `/usr/local/bin/node` instead.

Show the owner the plain summary in your own words: what gets updated, that their keys, business
profile, product, content, sales history, working hours and their own folders stay exactly as they
are, and that a backup of every replaced file is kept. Ask: **"Shall I go ahead?"** Wait for a yes.

## 4. Update for real

    node "<new>/system/update.js" --into "<machine>"

It backs up the replaced files into `<machine>/_before-update-YYYY-MM-DD-HHMM/`, copies in the new
program files and agents, installs the engine (npm install - a few minutes, a wall of text is
normal), re-registers the scheduled jobs in this same folder, and runs the health check.

- If it says the engine install didn't finish, run the exact command it prints (inside
  `<machine>/system`). Mac: `PATH="/usr/local/bin:$PATH" npm install`. Never `sudo` or `npm -g`.
- If it refuses, read the reason to the owner in plain words - nothing was changed.
- Running it again is safe: unchanged files are skipped and nothing is backed up twice.

## 5. Report, then a fresh start

Tell the owner, in a few plain lines: the version they're on now, what's new for them, that all
their info was kept, and where the backup is (they can delete it once everything works). Mention
anything the health check flagged, with the fix.

Then: **"Please start a new chat in this same folder (the + / New session button) so your updated
team loads."** The agents are read when a chat starts, so this chat still has the old ones.

You can delete the temporary folder from step 2. Leave the download itself to the owner.
