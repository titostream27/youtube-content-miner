#!/usr/bin/env bash
#
# Back up the SQLite database.
#
# Worth doing properly, because this file is the only irreplaceable thing in the
# deployment. Episodes and transcripts can be re-fetched; the clip library and
# the editor feedback in `clip_feedback` cannot - that accumulated judgement is
# the asset the product is built to grow.
#
# Uses `sqlite3 .backup` rather than `cp`. The database runs in WAL mode, so a
# plain copy can capture a main file whose recent commits still live in the
# write-ahead log, producing a backup that restores to an older state or fails
# integrity checks. `.backup` takes a consistent snapshot and works while the
# app is running, so no downtime is needed.
#
# Usage:
#   scripts/backup-db.sh [destination-directory]
#
# Inside the container:
#   docker compose exec app scripts/backup-db.sh /data/backups
#
# From the host, via cron (03:30 daily):
#   30 3 * * * docker compose -f /srv/content-miner/docker-compose.yml \
#                exec -T app scripts/backup-db.sh /data/backups >> /var/log/content-miner-backup.log 2>&1

set -euo pipefail

DB_PATH="${DATABASE_PATH:-data/content-miner.db}"
DEST_DIR="${1:-$(dirname "$DB_PATH")/backups}"
KEEP="${BACKUP_KEEP:-14}"

if [ ! -f "$DB_PATH" ]; then
  echo "No database at $DB_PATH - nothing to back up." >&2
  exit 1
fi

if ! command -v sqlite3 > /dev/null 2>&1; then
  echo "sqlite3 is not installed. It ships in the Docker image; on a host, install it first." >&2
  exit 1
fi

mkdir -p "$DEST_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$DEST_DIR/content-miner-$STAMP.db"

sqlite3 "$DB_PATH" ".backup '$TARGET'"

# Verify before trusting it. A backup that has never been read is a guess.
if ! sqlite3 "$TARGET" 'PRAGMA integrity_check;' | grep -q '^ok$'; then
  echo "Integrity check FAILED for $TARGET - keeping it for inspection." >&2
  exit 1
fi

CLIPS="$(sqlite3 "$TARGET" 'SELECT COUNT(*) FROM clips;')"
FEEDBACK="$(sqlite3 "$TARGET" 'SELECT COUNT(*) FROM clip_feedback;')"

gzip -f "$TARGET"
echo "Backed up to ${TARGET}.gz  (clips: $CLIPS, feedback rows: $FEEDBACK)"

# Rotate: keep the newest $KEEP archives.
COUNT="$(find "$DEST_DIR" -maxdepth 1 -name 'content-miner-*.db.gz' | wc -l)"
if [ "$COUNT" -gt "$KEEP" ]; then
  find "$DEST_DIR" -maxdepth 1 -name 'content-miner-*.db.gz' -print0 \
    | xargs -0 ls -1t \
    | tail -n +$((KEEP + 1)) \
    | while read -r old; do
        rm -f -- "$old"
        echo "Removed old backup $(basename "$old")"
      done
fi
