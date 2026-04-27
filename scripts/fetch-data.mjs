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

      // DTSTART/DTEND can have timezone parameters like:
      // DTSTART;TZID=Europe/Berlin:20260427T090000
      // Our `get("DTSTART")` already handles this by accepting key + ";".

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

  // Important: GitHub Actions runs in UTC.
  // Window is defined as "today 00:00 UTC" up to +14 days.
  const now = new Date();
  const windowStart = startOfDayUtc(now);
  const windowEnd = new Date(windowStart.getTime() + 14 * 24 * 60 * 60 * 1000);

  const decisions = {
    totalParsed: events.length,
    totalExpanded: 0,
    included: 0,
    excluded: 0,
    reasons: {
      missingStart: 0,
      missingLocation: 0,
      allDayNoTime: 0,
      unparseableStart: 0,
      outsideWindow: 0,
      outsideWindowAfterExpand: 0,
    },
    examples: {
      missingStart: [],
      missingLocation: [],
      allDayNoTime: [],
      unparseableStart: [],
      outsideWindow: [],
      outsideWindowAfterExpand: [],
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
      rrule: ev.rrule,
      ...extra,
    });
  };

  // 1) Pre-filter (basic validity) WITHOUT date window, so we can expand recurring events
  const baseCandidates = [];
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

    // If this is a non-recurring event and already outside window, we can exclude early
    // (recurring ones get expanded first).
    if (!ev.rrule && !(startDt >= windowStart && startDt < windowEnd)) {
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

    baseCandidates.push({ ev, startDt });
  }

  // 2) Expand recurring events into occurrences that fall within the window
  const expanded = [];
  for (const { ev, startDt } of baseCandidates) {
    if (!ev.rrule) {
      expanded.push({ ...ev, _occurrenceStart: ev.start, _occurrenceStartDt: startDt });
      continue;
    }

    const occurrences = expandRruleOccurrences({
      uid: ev.id,
      start: startDt,
      rrule: ev.rrule,
      windowStart,
      windowEnd,
      maxOccurrences: 200,
    });

    decisions.totalExpanded += occurrences.length;

    if (!occurrences.length) {
      // nothing in window
      decisions.excluded++;
      decisions.reasons.outsideWindowAfterExpand++;
      pushExample("outsideWindowAfterExpand", ev, {
        parsedStartUtc: startDt.toISOString(),
        windowStartUtc: windowStart.toISOString(),
        windowEndUtc: windowEnd.toISOString(),
      });
      console.log(
        `[exclude outsideWindowAfterExpand] id=${ev.id} title=${JSON.stringify(
          ev.title || ""
        )} DTSTART=${ev.start} RRULE=${JSON.stringify(ev.rrule)} baseStartUtc=${startDt.toISOString()} window=${windowStart.toISOString()}..${windowEnd.toISOString()}`
      );
      continue;
    }

    for (const occ of occurrences) {
      // Create a stable occurrence id (UID + start)
      const occId = `${ev.id}#${occ.startIcs}`;
      expanded.push({
        ...ev,
        id: occId,
        start: occ.startIcs,
        _occurrenceStart: occ.startIcs,
        _occurrenceStartDt: occ.startDt,
      });
    }
  }

  // 3) Final filter (window) on expanded set
  const inWindow = expanded
    .filter((ev) => {
      const startDt = ev._occurrenceStartDt || parseIcsDate(ev.start);
      return startDt && startDt >= windowStart && startDt < windowEnd;
    })
    .sort((a, b) => {
      const ad = a._occurrenceStartDt?.getTime?.() ?? parseIcsDate(a.start)?.getTime?.() ?? 0;
      const bd = b._occurrenceStartDt?.getTime?.() ?? parseIcsDate(b.start)?.getTime?.() ?? 0;
      return ad - bd;
    });

  decisions.included = inWindow.length;

  console.log("Decision summary:", JSON.stringify({ ...decisions, examples: undefined }, null, 2));

  const enrichedEvents = [];
  for (const event of inWindow) {
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

function toIcsLocalDateTime(dt) {
  // Convert a Date to YYYYMMDDTHHMMSS (local time components of the Date)
  // NOTE: dt is a JS Date, which internally is UTC-based, but getters without UTC use local TZ.
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  const ss = String(dt.getSeconds()).padStart(2, "0");
  return `${y}${m}${d}T${hh}${mm}${ss}`;
}

function expandRruleOccurrences({ uid, start, rrule, windowStart, windowEnd, maxOccurrences }) {
  // Minimal RRULE support for typical Google Calendar patterns.
  // Supports: FREQ=DAILY|WEEKLY, INTERVAL, BYDAY, UNTIL, COUNT
  // This is *not* a complete RFC5545 implementation, but enough for most lecture schedules.

  const rule = parseRrule(rrule);
  if (!rule.freq) return [];

  const interval = Number(rule.interval || 1);
  const until = rule.until ? parseIcsDate(rule.until) : null;
  const count = rule.count ? Number(rule.count) : null;

  const byday = rule.byday ? rule.byday.split(",").map((x) => x.trim()).filter(Boolean) : null;
  const weekdaySet = byday ? new Set(byday.map((d) => d.toUpperCase())) : null;

  const occurrences = [];

  // Generate forward from the series DTSTART.
  // Start iteration at max(windowStart - 7 days, start) to catch weekly rules.
  const seed = new Date(Math.max(start.getTime(), windowStart.getTime() - 7 * 86400000));

  let cursor = new Date(seed.getTime());
  let generated = 0;

  const max = maxOccurrences || 200;

  const matchesByDay = (dt) => {
    if (!weekdaySet) return true;
    const map = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    const key = map[dt.getDay()];
    return weekdaySet.has(key);
  };

  const addIfInWindow = (dt) => {
    if (until && dt > until) return false;
    if (dt >= windowEnd) return false;

    if (dt >= windowStart && dt < windowEnd) {
      occurrences.push({
        startDt: new Date(dt.getTime()),
        // Keep same style as original DTSTART: if original was Z keep Z, else local
        startIcs: rruleIncludesZ(start) ? toIcsUtc(dt) : toIcsLocalDateTime(dt),
      });
    }

    generated++;
    if (count && generated >= count) return false;
    if (occurrences.length >= max) return false;
    return true;
  };

  if (rule.freq === "DAILY") {
    // Step by N days
    while (cursor < windowEnd && occurrences.length < max) {
      if (matchesByDay(cursor)) {
        if (!addIfInWindow(cursor)) break;
      }
      cursor = new Date(cursor.getTime() + interval * 86400000);
    }
  } else if (rule.freq === "WEEKLY") {
    // Step day by day, but only include matching weekdays; advance weeks by interval
    // Simple approach: iterate days; for large windows this is still fine (14 days).
    const end = new Date(windowEnd.getTime());
    while (cursor < end && occurrences.length < max) {
      if (matchesByDay(cursor)) {
        if (!addIfInWindow(cursor)) break;
      }
      cursor = new Date(cursor.getTime() + 86400000);
    }
  } else {
    // Unsupported
    console.log(`[rrule] unsupported freq for ${uid}: ${rrule}`);
    return [];
  }

  return occurrences;
}

function parseRrule(rrule) {
  const out = {};
  const parts = String(rrule || "")
    .trim()
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);

  for (const p of parts) {
    const [k, v] = p.split("=");
    if (!k || v == null) continue;
    out[k.toLowerCase()] = v;
  }

  // Normalize some keys
  return {
    freq: out.freq ? String(out.freq).toUpperCase() : null,
    interval: out.interval,
    byday: out.byday,
    until: out.until,
    count: out.count,
  };
}

function toIcsUtc(dt) {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  const hh = String(dt.getUTCHours()).padStart(2, "0");
  const mm = String(dt.getUTCMinutes()).padStart(2, "0");
  const ss = String(dt.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${d}T${hh}${mm}${ss}Z`;
}

function rruleIncludesZ(start) {
  // if start is in UTC; heuristic: in our code `start` is a Date already.
  // We cannot detect original string here; return false to emit local by default.
  // (The view parses both formats.)
  return false;
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
