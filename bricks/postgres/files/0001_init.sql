-- initial migration
create table if not exists health (
  id integer primary key,
  checked_at timestamptz not null default now()
);
