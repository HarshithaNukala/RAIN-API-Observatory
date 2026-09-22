CREATE TABLE incidents (
    id BIGSERIAL PRIMARY KEY,
    api_service_id BIGINT NOT NULL REFERENCES api_services(id) ON DELETE CASCADE,
    status VARCHAR(32) NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    resolved_at TIMESTAMP WITH TIME ZONE,
    first_health_check_id BIGINT NOT NULL REFERENCES health_checks(id) ON DELETE RESTRICT,
    latest_health_check_id BIGINT NOT NULL REFERENCES health_checks(id) ON DELETE RESTRICT,
    failure_count INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_incidents_api_id_status ON incidents(api_service_id, status);
CREATE INDEX idx_incidents_started_at ON incidents(started_at DESC);

CREATE UNIQUE INDEX uq_incidents_one_open_per_api
ON incidents(api_service_id)
WHERE status = 'OPEN';
