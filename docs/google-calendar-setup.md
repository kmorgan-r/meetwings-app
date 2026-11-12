# Google Calendar setup

## 1. Create the Google app (once per organisation)

Someone with a Google Workspace account in your organisation does this once.

1. `gcloud projects create <id> --organization=<your org id>`
2. `gcloud services enable calendar-json.googleapis.com --project=<id>`
3. Cloud Console → Google Auth Platform → Audience: **Internal**. Scopes: `openid`, `email`,
   `https://www.googleapis.com/auth/calendar.events.readonly`.
4. Clients → Create client → **Desktop app**. This yields a Client ID and a Client secret.

Steps 3 and 4 are console-only: gcloud has no command for standard OAuth clients. **Internal** is what
makes this cheap: no Google verification, only accounts in your Google Workspace can sign in, and
refresh tokens don't expire after 7 days as they do for unverified External apps in testing mode.

## 2. If your Workspace restricts third-party apps

If your Workspace admin restricts third-party apps, the app also needs marking as trusted in the Admin
console (Security → API controls).

## 3. Connect each teammate

Send each teammate the Client ID and Client secret. In Meetwings, open **Integrations** in the sidebar,
paste both values into the **Google Calendar** card, then press **Connect**.

## What Meetwings reads

Read-only access to the current event's guest list only. Nothing is written to your calendar.
