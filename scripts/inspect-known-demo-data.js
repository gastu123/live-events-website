import "dotenv/config";
import pg from "pg";

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
try {
  const result = await client.query(
    `select e.id,e.slug,e.title,e.deleted_at,
       (select count(*) from orders o where o.event_id=e.id)::int order_count,
       (select count(*) from event_sections s where s.event_id=e.id)::int section_count
     from events e
     where e.id='10000000-0000-4000-8000-000000000001'
       and e.slug='development-live-show'`,
  );
  const orders = await client.query(
    `select o.id,o.reference,o.status,
       (lower(o.contact_email) like '%@local.demo' or lower(o.contact_email) like '%@example.invalid') known_demo_email,
       (p.full_name in ('Local Demo Customer','Hosted Smoke Test')) known_demo_profile
     from orders o left join profiles p on p.id=o.profile_id
     where o.event_id='10000000-0000-4000-8000-000000000001'`,
  );
  console.log(JSON.stringify({ events: result.rows, orders: orders.rows }));
} finally {
  await client.end();
}
