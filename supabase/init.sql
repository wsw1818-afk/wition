-- Wition Supabase 스키마 (사용자별 데이터 분리)

-- 역할 생성 (PostgREST가 JWT의 role 클레임으로 전환)
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;

-- 기본 권한 부여
GRANT USAGE ON SCHEMA public TO anon, service_role, postgres;
-- service_role/postgres는 전체 권한
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role, postgres;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role, postgres;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role, postgres;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role, postgres;
-- anon(인증 전)/authenticated(인증 후) 역할은 DML만 허용
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO anon, authenticated;

-- note_day: 날짜별 메타데이터 (사용자별)
CREATE TABLE IF NOT EXISTS note_day (
  id          TEXT NOT NULL,               -- "YYYY-MM-DD"
  user_id     TEXT NOT NULL,               -- GoTrue user UUID
  mood        TEXT,
  summary     TEXT,
  note_count  INTEGER NOT NULL DEFAULT 0,
  has_notes   INTEGER NOT NULL DEFAULT 0,
  updated_at  BIGINT NOT NULL,
  PRIMARY KEY (id, user_id)
);

-- note_item: 블록 데이터 (사용자별)
CREATE TABLE IF NOT EXISTS note_item (
  id          TEXT NOT NULL,               -- UUID
  user_id     TEXT NOT NULL,               -- GoTrue user UUID
  day_id      TEXT NOT NULL,
  type        TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '[]',
  pinned      INTEGER NOT NULL DEFAULT 0,
  order_index INTEGER NOT NULL,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  PRIMARY KEY (id, user_id)
);

-- alarm: 알람 데이터 (사용자별)
CREATE TABLE IF NOT EXISTS alarm (
  id          TEXT NOT NULL,               -- UUID
  user_id     TEXT NOT NULL,               -- GoTrue user UUID
  day_id      TEXT NOT NULL,               -- "YYYY-MM-DD"
  time        TEXT NOT NULL,               -- "HH:mm"
  label       TEXT NOT NULL DEFAULT '',
  repeat      TEXT NOT NULL DEFAULT 'none',
  enabled     INTEGER NOT NULL DEFAULT 1,
  fired       INTEGER NOT NULL DEFAULT 0,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  PRIMARY KEY (id, user_id)
);

-- attachment_file: 첨부파일 바이너리 (사용자별)
CREATE TABLE IF NOT EXISTS attachment_file (
  file_name   TEXT NOT NULL,               -- "timestamp_filename.ext"
  user_id     TEXT NOT NULL,               -- GoTrue user UUID
  data        TEXT NOT NULL,               -- base64 인코딩된 파일 데이터
  size        INTEGER NOT NULL DEFAULT 0,
  mime_type   TEXT NOT NULL DEFAULT 'application/octet-stream',
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  PRIMARY KEY (file_name, user_id)
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_noteday_userid ON note_day(user_id);
CREATE INDEX IF NOT EXISTS idx_noteitem_userid ON note_item(user_id);
CREATE INDEX IF NOT EXISTS idx_noteitem_dayid ON note_item(day_id);
CREATE INDEX IF NOT EXISTS idx_noteitem_dayid_order ON note_item(day_id, pinned DESC, order_index ASC);
CREATE INDEX IF NOT EXISTS idx_alarm_userid ON alarm(user_id);
CREATE INDEX IF NOT EXISTS idx_alarm_dayid ON alarm(day_id);
CREATE INDEX IF NOT EXISTS idx_attachment_userid ON attachment_file(user_id);

-- RLS (Row Level Security) — JWT의 user_id 기반 접근 제어
-- auth.uid()는 GoTrue가 자동 생성 (UUID 반환, request.jwt.claim.sub 기반)
ALTER TABLE note_day ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE alarm ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachment_file ENABLE ROW LEVEL SECURITY;

-- note_day: 본인 데이터만 접근
CREATE POLICY "Users can access own note_day" ON note_day FOR ALL
  USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

-- note_item: 본인 데이터만 접근
CREATE POLICY "Users can access own note_item" ON note_item FOR ALL
  USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

-- alarm: 본인 데이터만 접근
CREATE POLICY "Users can access own alarm" ON alarm FOR ALL
  USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

-- attachment_file: 본인 데이터만 접근
CREATE POLICY "Users can access own attachment_file" ON attachment_file FOR ALL
  USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

-- service_role은 RLS 우회 (관리 작업용)
ALTER TABLE note_day FORCE ROW LEVEL SECURITY;
ALTER TABLE note_item FORCE ROW LEVEL SECURITY;
ALTER TABLE alarm FORCE ROW LEVEL SECURITY;
ALTER TABLE attachment_file FORCE ROW LEVEL SECURITY;

-- ── Realtime 서비스용 설정 ──

-- supabase_admin 역할 (Realtime 서비스가 사용)
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    CREATE ROLE supabase_admin LOGIN PASSWORD 'wition_db_2024';
  END IF;
END $$;
GRANT ALL ON SCHEMA public TO supabase_admin;
GRANT ALL ON ALL TABLES IN SCHEMA public TO supabase_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO supabase_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO supabase_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO supabase_admin;
-- supabase_admin은 RLS를 우회할 수 있어야 함
ALTER ROLE supabase_admin BYPASSRLS;

-- _realtime 스키마 (Realtime 서비스 내부용)
CREATE SCHEMA IF NOT EXISTS _realtime;
GRANT ALL ON SCHEMA _realtime TO supabase_admin;

-- Realtime publication: 실시간 변경 감지할 테이블 등록
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

-- 실시간 동기화 대상 테이블 등록
ALTER PUBLICATION supabase_realtime ADD TABLE note_day;
ALTER PUBLICATION supabase_realtime ADD TABLE note_item;
ALTER PUBLICATION supabase_realtime ADD TABLE alarm;
