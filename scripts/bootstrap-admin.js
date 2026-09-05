import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { strongPassword } from "../server/schemas.js";

const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "DATABASE_URL", "INITIAL_SUPER_ADMIN_EMAIL", "INITIAL_SUPER_ADMIN_PASSWORD"];
for (const name of required)
  if (!process.env[name]) throw new Error(`${name} must be set directly in .env before bootstrapping.`);
const password = strongPassword.safeParse(process.env.INITIAL_SUPER_ADMIN_PASSWORD);
if (!password.success) throw new Error("INITIAL_SUPER_ADMIN_PASSWORD does not meet the strong-password policy.");
const email = process.env.INITIAL_SUPER_ADMIN_EMAIL.trim().toLowerCase();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
let user;
for (let page = 1; page <= 20 && !user; page += 1) {
  const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
  if (error) throw new Error("Supabase Auth administrator access failed. Verify the server-side service-role key.");
  user = data.users.find((candidate) => candidate.email?.toLowerCase() === email);
  if (data.users.length < 100) break;
}
if (user) {
  const { data, error } = await supabase.auth.admin.updateUserById(user.id, {
    password: password.data,
    email_confirm: true,
    user_metadata: { ...user.user_metadata, full_name: user.user_metadata?.full_name || "Initial Super Administrator" },
  });
  if (error || !data.user) throw new Error("The existing Supabase Auth administrator could not be verified.");
  user = data.user;
} else {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: password.data,
    email_confirm: true,
    user_metadata: { full_name: "Initial Super Administrator" },
  });
  if (error || !data.user) throw new Error("The Supabase Auth administrator could not be created and verified.");
  user = data.user;
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "insert into profiles(id,full_name) values($1,'Initial Super Administrator') on conflict(id) do update set deleted_at=null,updated_at=now()",
      [user.id],
    );
    const role = (await client.query("select id from admin_roles where name='Super Administrator'")).rows[0];
    if (!role) throw new Error("Super Administrator role is missing. Run migrations and seed first.");
    await client.query(
      `insert into admin_users(profile_id,role_id,is_super_admin,status,two_factor_required,recovery_email)
       values($1,$2,true,'active',true,$3)
       on conflict(profile_id) do update set role_id=excluded.role_id,is_super_admin=true,status='active',
         two_factor_required=true,recovery_email=coalesce(admin_users.recovery_email,excluded.recovery_email),deleted_at=null,updated_at=now()`,
      [user.id, role.id, email],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
console.log(`Initial Super Administrator is active: ${email}`);
