ALTER TABLE api_services ADD COLUMN request_body TEXT;
ALTER TABLE api_services ADD COLUMN last_checked_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE api_services ADD COLUMN next_check_at TIMESTAMP WITH TIME ZONE;

CREATE TABLE health_checks (
    id BIGSERIAL PRIMARY KEY,
    api_service_id BIGINT NOT NULL REFERENCES api_services(id) ON DELETE CASCADE,
    checked_at TIMESTAMP WITH TIME ZONE NOT NULL,
    success BOOLEAN NOT NULL,
    status VARCHAR(32) NOT NULL,
    http_status INTEGER,
    latency_ms INTEGER,
    error_type VARCHAR(64),
    error_message TEXT
);

CREATE INDEX idx_health_checks_api_id ON health_checks(api_service_id, checked_at DESC);
