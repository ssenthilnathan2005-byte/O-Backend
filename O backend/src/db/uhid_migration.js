"use strict";
// One-time, idempotent UHID migration (safe to run more than once).
require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function steps(orderBy) {
  return [
    `CREATE TABLE IF NOT EXISTS public.users_backup_pre_uhid AS TABLE public.users`,
    `LOCK TABLE public.users IN SHARE ROW EXCLUSIVE MODE`,
    `CREATE SEQUENCE IF NOT EXISTS public.uhid_seq START 1`,
    `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS uhid TEXT`,
    `CREATE OR REPLACE FUNCTION public.assign_uhid() RETURNS trigger AS $fn$
     DECLARE n BIGINT;
     BEGIN
       IF TG_OP = 'UPDATE' AND OLD.uhid IS NOT NULL THEN
         NEW.uhid := OLD.uhid;
       ELSIF NEW.role = 'patient' AND (TG_OP = 'INSERT' OR NEW.uhid IS NULL OR NEW.uhid = '') THEN
         n := nextval('public.uhid_seq');
         NEW.uhid := 'DB' || CASE WHEN n < 10 THEN '0' || n::text ELSE n::text END;
       END IF;
       RETURN NEW;
     END
     $fn$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS trg_assign_uhid ON public.users`,
    `CREATE TRIGGER trg_assign_uhid BEFORE INSERT OR UPDATE ON public.users
       FOR EACH ROW EXECUTE FUNCTION public.assign_uhid()`,
    `DO $do$
     DECLARE r RECORD;
     BEGIN
       FOR r IN SELECT id FROM public.users WHERE role = 'patient' AND uhid IS NULL ORDER BY ${orderBy} LOOP
         UPDATE public.users SET uhid = NULL WHERE id = r.id;
       END LOOP;
     END
     $do$`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_users_uhid ON public.users (uhid) WHERE uhid IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_users_patient_phone ON public.users (phone)
       WHERE role = 'patient' AND phone IS NOT NULL AND phone <> ''`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_users_patient_email ON public.users (lower(email))
       WHERE role = 'patient' AND email IS NOT NULL AND email <> ''`,
    `ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_patient_has_uhid`,
    `ALTER TABLE public.users ADD CONSTRAINT users_patient_has_uhid
       CHECK (role <> 'patient' OR uhid IS NOT NULL)`,
  ];
}

(async () => {
  const client = await pool.connect();
  try {
    const { rows: c } = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='users' AND column_name='created_at'`
    );
    const orderBy = c.length ? "created_at NULLS LAST, id" : "id";
    await client.query("BEGIN");
    for (const sql of steps(orderBy)) await client.query(sql);
    await client.query("COMMIT");
    console.log("UHID migration done.");
    console.log((await client.query(
      "SELECT uhid, role FROM public.users WHERE uhid IS NOT NULL ORDER BY length(uhid), uhid")).rows);
    console.log("patients without UHID:", (await client.query(
      "SELECT count(*) FROM public.users WHERE role='patient' AND uhid IS NULL")).rows);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("MIGRATION FAILED, rolled back:", e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();