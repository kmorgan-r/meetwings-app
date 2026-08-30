// Inspect or poke the app's meeting-log queue. The app holds the database open,
// so CLOSE MEETWINGS before any command that writes.
//
//   node .livecheck/queue-poke.mjs show
//   node .livecheck/queue-poke.mjs backup
//   node .livecheck/queue-poke.mjs unsend-write-failure   <-- forces leg 4's state
//
// `unsend-write-failure` reproduces the one state the live harness cannot: a
// target whose message_post reached Odoo but whose local `sent` write did not.
// It sets a sent target back to `pending` while KEEPING its message_id, which is
// exactly what a crash in that window leaves behind.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DB = path.join(process.env.APPDATA, "com.meetwings.app", "meetwings.db");
const cmd = process.argv[2] ?? "show";

console.log("db:", DB, fs.existsSync(DB) ? `(${fs.statSync(DB).size} bytes)` : "(MISSING)");

if (cmd === "backup") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dest = path.join(process.env.APPDATA, `meetwings-db-backup-${stamp}.db`);
  fs.copyFileSync(DB, dest);
  console.log("backed up ->", dest);
  process.exit(0);
}

const db = new DatabaseSync(DB, { readOnly: cmd === "show" });

const show = () => {
  console.log(
    "\nqueue:",
    JSON.stringify(
      db
        .prepare(
          "SELECT id, status, attempts, last_error_code, sent_at FROM meeting_log_queue ORDER BY created_at DESC LIMIT 5"
        )
        .all(),
      null,
      1
    )
  );
  console.log(
    "\ntargets:",
    JSON.stringify(
      db
        .prepare(
          "SELECT row_id, model, res_id, name, status, attachment_id, message_id FROM meeting_log_targets ORDER BY created_at DESC LIMIT 10"
        )
        .all(),
      null,
      1
    )
  );
  console.log(
    "\nselected:",
    JSON.stringify(db.prepare("SELECT model, res_id, name FROM odoo_selected_targets").all())
  );
};

if (cmd === "show") {
  show();
} else if (cmd === "unsend-write-failure") {
  const victim = db
    .prepare(
      "SELECT id, row_id, model, res_id, message_id FROM meeting_log_targets WHERE status = 'sent' AND message_id IS NOT NULL ORDER BY sent_at DESC LIMIT 1"
    )
    .get();
  if (!victim) {
    console.log("no sent target with a message_id - send a meeting first");
    process.exit(1);
  }
  console.log("forcing the post-write-failure state on:", JSON.stringify(victim));
  db.prepare(
    "UPDATE meeting_log_targets SET status = 'pending', sent_at = NULL WHERE id = ?"
  ).run(victim.id);
  db.prepare(
    "UPDATE meeting_log_queue SET status = 'pending', sent_at = NULL WHERE id = ?"
  ).run(victim.row_id);
  console.log("done - relaunch the app and open the meeting-log page");
  show();
} else {
  console.log("unknown command:", cmd);
  process.exit(1);
}
