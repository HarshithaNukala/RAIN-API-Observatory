CREATE TABLE api_services (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    url VARCHAR(2048) NOT NULL,
    method VARCHAR(10) NOT NULL,
    description TEXT,
    expected_status_code INTEGER NOT NULL,
    timeout_ms INTEGER NOT NULL,
    latency_threshold_ms INTEGER NOT NULL,
    check_interval_seconds INTEGER NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    current_status VARCHAR(50) NOT NULL DEFAULT 'UNKNOWN',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE api_headers (
    id BIGSERIAL PRIMARY KEY,
    api_service_id BIGINT NOT NULL REFERENCES api_services(id) ON DELETE CASCADE,
    header_name VARCHAR(255) NOT NULL,
    header_value VARCHAR(4096) NOT NULL
);
