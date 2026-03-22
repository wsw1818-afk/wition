const http = require('http')
const https = require('https')

const PORT = 5190
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:8000'
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

function fetchJSON(url, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, { headers }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error(`Parse error: ${data.slice(0, 200)}`)) }
      })
    })
    req.on('error', reject)
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')) })
  })
}

function escapeICS(str) {
  return (str || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')
}

function pad2(n) { return String(n).padStart(2, '0') }

function alarmToVEVENT(alarm) {
  const dayId = alarm.day_id         // "2026-03-20"
  const time = alarm.time            // "14:30" or "09:00"
  const label = alarm.label || '알림'
  const id = alarm.id
  const created = alarm.created_at
  const updated = alarm.updated_at

  // DTSTART: YYYYMMDDTHHMMSS
  const [year, month, day] = dayId.split('-')
  const [hour, min] = time.split(':')
  const dtStart = `${year}${month}${day}T${pad2(hour)}${pad2(min)}00`
  const dtEnd = `${year}${month}${day}T${pad2(Number(hour) + 1 > 23 ? 23 : Number(hour) + 1)}${pad2(min)}00`

  // RRULE for repeat
  let rrule = ''
  if (alarm.repeat && alarm.repeat !== 'none') {
    const map = {
      daily: 'FREQ=DAILY',
      weekly: 'FREQ=WEEKLY',
      monthly: 'FREQ=MONTHLY',
      yearly: 'FREQ=YEARLY',
      weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    }
    if (map[alarm.repeat]) rrule = `RRULE:${map[alarm.repeat]}`
  }

  // DTSTAMP from updated_at (epoch ms)
  const stamp = new Date(updated)
  const dtstamp = `${stamp.getUTCFullYear()}${pad2(stamp.getUTCMonth() + 1)}${pad2(stamp.getUTCDate())}T${pad2(stamp.getUTCHours())}${pad2(stamp.getUTCMinutes())}${pad2(stamp.getUTCSeconds())}Z`

  const lines = [
    'BEGIN:VEVENT',
    `UID:${id}@wition`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${escapeICS(label)}`,
    `DESCRIPTION:Wition - ${escapeICS(dayId)} ${escapeICS(time)}`,
  ]
  if (rrule) lines.push(rrule)
  // 5분 전 알림
  lines.push(
    'BEGIN:VALARM',
    'TRIGGER:-PT5M',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeICS(label)}`,
    'END:VALARM',
  )
  lines.push('END:VEVENT')
  return lines.join('\r\n')
}

async function generateICS() {
  const url = `${SUPABASE_URL}/rest/v1/alarm?enabled=eq.1&select=*`
  const headers = {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  }

  const alarms = await fetchJSON(url, headers)
  if (!Array.isArray(alarms)) throw new Error('Invalid response from Supabase')

  const events = alarms.map(alarmToVEVENT).join('\r\n')

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Wition//Calendar//KO',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Wition',
    'X-WR-TIMEZONE:Asia/Seoul',
    // Timezone definition
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Seoul',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0900',
    'TZOFFSETTO:+0900',
    'TZNAME:KST',
    'END:STANDARD',
    'END:VTIMEZONE',
    events,
    'END:VCALENDAR',
  ].join('\r\n')
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.url === '/calendar.ics' || req.url === '/') {
    try {
      const ics = await generateICS()
      res.writeHead(200, {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="wition.ics"',
      })
      res.end(ics)
    } catch (err) {
      console.error('[ICS] Error:', err.message)
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('Internal Server Error')
    }
    return
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('OK')
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not Found. Use /calendar.ics')
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Wition ICS Server running on port ${PORT}`)
  console.log(`  Local:     http://localhost:${PORT}/calendar.ics`)
  console.log(`  Tailscale: http://100.122.232.19:${PORT}/calendar.ics`)
  console.log(`  LAN:       http://192.168.45.152:${PORT}/calendar.ics`)
})
