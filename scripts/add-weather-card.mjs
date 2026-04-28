import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });
const board = await sql`SELECT id FROM ops.kanban_boards WHERE slug='dev'`;

const body = `Henry should know where the operator is, what time it is, and what the weather is doing — the same context a foreman has when planning the day.

## Tools to add
- \`get_current_time\` — returns now in tenant.timezone (string + ISO). Trivial; explicit so Henry never says "I do not know what time it is."
- \`get_my_location\` — best-effort. Priority: (1) browser Geolocation API passed via the screen-context tools we already have, (2) most-recent-active-job customer.lat/lng, (3) tenant business address.
- \`get_weather(lat, lng, days_ahead?)\` — current conditions + 7-day forecast. Use Open-Meteo (free, no API key, well-documented JSON) by default. Returns: temp, conditions, precipitation chance, wind, sunrise/sunset.
- \`get_weather_for_job(job_id)\` — convenience wrapper that resolves customer.lat/lng for a job and calls get_weather.

## Use cases that unlock
- "Will the sauna pad pour work tomorrow?" → checks the job site weather
- "Should I reschedule the deck stain this week?" → 7-day rain forecast
- "It is 4pm Friday — what is left on the Morrison job?" → time + tasks
- Proactive: nightly henry-suggestion if a scheduled outdoor task has rain forecast on the day

## Implementation notes
- Open-Meteo is free, no key, no rate limit for personal use. Endpoint: https://api.open-meteo.com/v1/forecast
- Cache weather lookups for 30 min server-side (per lat/lng rounded to 0.1°) to avoid hammering on a chatty session
- Add tools to src/lib/ai/tools/weather.ts; register in tools/index.ts
- Bump tool-count tests
- No new env vars needed (Open-Meteo is free)

## Out of scope
- Pushing weather alerts to operators (Phase 2)
- Severe weather notifications (Phase 2)
- Pollen / air quality / UV (low value for contractors)`;

await sql`
  INSERT INTO ops.kanban_cards
    (board_id, column_key, title, body, tags, priority, size_points,
     suggested_agent, actor_type, actor_name, order_in_column)
  VALUES (${board[0].id}, 'backlog',
          'Henry: weather + location + time awareness',
          ${body},
          ARRAY['epic:agents', 'henry-intelligence'],
          3, 5, 'ai', 'human', 'jonathan', 0)
`;
console.log('card created');
await sql.end();
