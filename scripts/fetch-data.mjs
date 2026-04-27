import fs from "fs/promises";

const ICS_URL =
  "https://calendar.google.com/calendar/ical/ce992f3cbc85a332aff75577f178b0677206d4c1bb55bfac3b2848b740438b1f%40group.calendar.google.com/public/basic.ics";
const OUTPUT_FILE = process.env.OUTPUT_FILE || "data.json";

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
        icsGeo: parseIcsGeo(get("GEO")),
      };
    });

  // Filter requirements:
  // - next 14 days (by DTSTART)
  // - must have location
  // - must have a time component (not all-day YYYYMMDD)
  //
  // Important: GitHub Actions runs in UTC. If we filter with "now" including time,
  // events on the same day but earlier than the build time would be dropped.
  // Therefore we start the window at the beginning of today (UTC).
  const now = new Date();
  const windowStart = startOfDayUtc(now);
  const windowEnd = new Date(windowStart.getTime() + 14 * 24 * 60 * 60 * 1000);

  const decisions = {
    totalParsed: events.length,
    included: 0,
    excluded: 0,
    reasons: {
      missingStart: 0,
      missingLocation: 0,
      allDayNoTime: 0,
      unparseableStart: 0,
      outsideWindow: 0,
    },
    examples: {
      missingStart: [],
      missingLocation: [],
      allDayNoTime: [],
      unparseableStart: [],
      outsideWindow: [],
    },
  };

  const EXAMPLE_LIMIT = 20;
  const pushExample = (bucket, ev, extra = {}) => {
    if (decisions.examples[bucket].length >= EXAMPLE_LIMIT) return;
    decisions.examples[bucket].push({
      id: ev.id,
      title: ev.title,
      start: ev.start,
      location: ev.location,
      ...extra,
    });
  };

  const include = [];
  for (const ev of events) {
    const base = `id=${ev.id} title=${JSON.stringify(ev.title || "")} start=${JSON.stringify(
      ev.start || ""
    )} location=${JSON.stringify(ev.location || "")}`;

    if (!ev.start) {
      decisions.excluded++;
      decisions.reasons.missingStart++;
      pushExample("missingStart", ev);
      console.log(`[exclude missingStart] ${base}`);
      continue;
    }

    if (!ev.location || !String(ev.location).trim()) {
      decisions.excluded++;
      decisions.reasons.missingLocation++;
      pushExample("missingLocation", ev);
      console.log(`[exclude missingLocation] ${base}`);
      continue;
    }

    if (!hasTimeComponent(ev.start)) {
      decisions.excluded++;
      decisions.reasons.allDayNoTime++;
      pushExample("allDayNoTime", ev);
      console.log(`[exclude allDayNoTime] ${base}`);
      continue;
    }

    const startDt = parseIcsDate(ev.start);
    if (!startDt) {
      decisions.excluded++;
      decisions.reasons.unparseableStart++;
      pushExample("unparseableStart", ev);
      console.log(`[exclude unparseableStart] ${base}`);
      continue;
    }

    if (!(startDt >= windowStart && startDt < windowEnd)) {
      decisions.excluded++;
      decisions.reasons.outsideWindow++;
      pushExample("outsideWindow", ev, {
        parsedStartUtc: startDt.toISOString(),
        windowStartUtc: windowStart.toISOString(),
        windowEndUtc: windowEnd.toISOString(),
      });
      console.log(
        `[exclude outsideWindow] ${base} parsedStartUtc=${startDt.toISOString()} window=${windowStart.toISOString()}..${windowEnd.toISOString()}`
      );
      continue;
    }

    decisions.included++;
    console.log(`[include] ${base} parsedStartUtc=${startDt.toISOString()}`);
    include.push(ev);
  }

  console.log("Decision summary:", JSON.stringify({ ...decisions, examples: undefined }, null, 2));

  const filtered = include.sort((a, b) => {
    const ad = parseIcsDate(a.start)?.getTime?.() ?? 0;
    const bd = parseIcsDate(b.start)?.getTime?.() ?? 0;
    return ad - bd;
  });

  const enrichedEvents = [];
  for (const event of filtered) {
    const geo = event.icsGeo || (await geocode(event.location));
    enrichedEvents.push({
      id: event.id,
      title: event.title,
      location: event.location,
      description: event.description,
      start: event.start,
      end: event.end,
      rrule: event.rrule,
      latitude: geo?.lat ?? null,
      longitude: geo?.lon ?? null,
      geo,
    });

    if (event.location) {
      await sleep(1100);
    }
  }

  await fs.mkdir("docs", { recursive: true });
  await fs.writeFile(
    `docs/${OUTPUT_FILE}`,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: ICS_URL,
        windowDays: 14,
        filtered: {
          requireLocation: true,
          requireTime: true,
          excludeAllDay: true,
          windowStartUtc: windowStart.toISOString(),
          windowEndUtc: windowEnd.toISOString(),
        },
        debug: {
          decisions,
        },
        count: enrichedEvents.length,
        events: enrichedEvents,
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(
    `Wrote ${enrichedEvents.length} events to ${OUTPUT_FILE} (next 14 days from ${windowStart.toISOString()} UTC, with time+location)`
  );

  // Save original (raw) ICS from the source
  await fs.writeFile("docs/calendar-original.ics", text, "utf8");
  console.log("Wrote original ICS to docs/calendar-original.ics");

  // Build and save normalized ICS from enriched events
  const normalizedIcs = buildIcs(enrichedEvents);
  await fs.writeFile("docs/calendar.ics", normalizedIcs, "utf8");
  console.log("Wrote normalized ICS to docs/calendar.ics");
}

async function geocode(location) {
  if (!location) return null;

  const normalizedLocation = normalizeLocation(location);
  const key = normalizedLocation.trim().toLowerCase();
  if (!key) return null;

  if (geoCache.has(key)) {
    return geoCache.get(key);
  }

  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" +
    encodeURIComponent(normalizedLocation);

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
        displayName: first.display_name || normalizedLocation,
        source: "nominatim",
      }
    : null;

  geoCache.set(key, result);
  return result;
}

function parseIcsGeo(value) {
  if (!value) return null;

  const [rawLat, rawLon] = value.split(/[;,]/).map((part) => part.trim());
  const lat = Number(rawLat);
  const lon = Number(rawLon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  return {
    lat,
    lon,
    source: "ics",
  };
}

function normalizeLocation(location) {
  return location
    .replace(/^Beispielort:\s*/i, "")
    .replace(/\\,/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasTimeComponent(value) {
  // DTSTART/DTEND can be:
  // - YYYYMMDD (all-day) -> no time component
  // - YYYYMMDDTHHMMSSZ / YYYYMMDDTHHMMSS -> has time
  const v = String(value || "").trim();
  if (!v) return false;
  return !/^\d{8}$/.test(v);
}

function startOfDayUtc(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
}

function parseIcsDate(value) {
  // Common formats:
  // - 20260427T083000Z
  // - 20260427T083000
  // - 20260427
  if (!value) return null;

  const v = String(value).trim();
  if (!v) return null;

  // Date-only (all-day)
  if (/^\d{8}$/.test(v)) {
    const y = Number(v.slice(0, 4));
    const m = Number(v.slice(4, 6)) - 1;
    const d = Number(v.slice(6, 8));
    return new Date(Date.UTC(y, m, d, 0, 0, 0));
  }

  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const isUtc = Boolean(m[7]);

  return isUtc
    ? new Date(Date.UTC(year, month, day, hour, minute, second))
    : new Date(year, month, day, hour, minute, second);
}

function escapeIcsText(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function buildIcs(events) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//pendler-api//calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];

  for (const ev of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${ev.id}`);
    if (ev.title) lines.push(`SUMMARY:${escapeIcsText(ev.title)}`);
    if (ev.location) lines.push(`LOCATION:${escapeIcsText(ev.location)}`);
    if (ev.description) lines.push(`DESCRIPTION:${escapeIcsText(ev.description)}`);
    if (ev.start) lines.push(`DTSTART:${ev.start}`);
    if (ev.end) lines.push(`DTEND:${ev.end}`);
    if (ev.rrule) lines.push(`RRULE:${ev.rrule}`);
    if (ev.latitude != null && ev.longitude != null) {
      lines.push(`GEO:${ev.latitude};${ev.longitude}`);
    }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
