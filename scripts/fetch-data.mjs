// const fs = require("fs/promises");
import fs from "fs/promises";

// const ICS_URL = process.env.ICS_URL;
const ICS_URL = 'https://calendar.google.com/calendar/ical/ce992f3cbc85a332aff75577f178b0677206d4c1bb55bfac3b2848b740438b1f%40group.calendar.google.com/public/basic.ics';
const OUTPUT_FILE = process.env.OUTPUT_FILE || "./data.json";

const geoCache = new Map();

async function main() {
  if (!ICS_URL) {
    throw new Error("ICS_URL fehlt");
  }

  const res = await fetch(ICS_URL, {
    headers: {
      "User-Agent": "github-actions-calendar-script/1.0",
      Accept: "text/calendar,text/plain;q=0.9,*/*;q=0.8",
    },
  });

  if (!res.ok) {
    throw new Error(`ICS konnte nicht geladen werden: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();

  const events = text
    .replace(/\r\n[ \t]/g, "")
    .split("BEGIN:VEVENT")
    .slice(1)
    .map((chunk, index) => {
      const lines = chunk.split(/\r?\n/);

      const get = (key) => {
        const line = lines.find((l) => l.startsWith(key + ":") || l.startsWith(key + ";"));
        if (!line) return "";
        return line.slice(line.indexOf(":") + 1).trim();
      };

      return {
        id: get("UID") || `event-${index + 1}`,
        title: get("SUMMARY"),
        location: get("LOCATION"),
        description: get("DESCRIPTION"),
        start: get("DTSTART"),
        end: get("DTEND"),
        rrule: get("RRULE") || null,
      };
    });

  const enrichedEvents = [];
  for (const event of events) {
    const geo = await geocode(event.location);
    enrichedEvents.push({
      ...event,
      geo,
    });

    if (event.location) {
      await sleep(1100);
    }
  }

  await fs.writeFile(
    OUTPUT_FILE,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: ICS_URL,
        count: enrichedEvents.length,
        events: enrichedEvents,
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(`Wrote ${enrichedEvents.length} events to ${OUTPUT_FILE}`);
}

async function geocode(location) {
  if (!location) return null;

  const key = location.trim().toLowerCase();
  if (!key) return null;

  if (geoCache.has(key)) {
    return geoCache.get(key);
  }

  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" +
    encodeURIComponent(location);

  const res = await fetch(url, {
    headers: {
      "User-Agent": "github-actions-calendar-script/1.0",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Geocoding fehlgeschlagen für "${location}": ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const first = Array.isArray(data) ? data[0] : null;

  const result = first
    ? {
        lat: Number(first.lat),
        lon: Number(first.lon),
        displayName: first.display_name || location,
        source: "nominatim",
      }
    : null;

  geoCache.set(key, result);
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});