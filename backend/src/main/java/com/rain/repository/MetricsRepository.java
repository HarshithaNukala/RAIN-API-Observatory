package com.rain.repository;

import com.rain.dto.ApiMetricsResponse;
import com.rain.dto.DashboardSummaryResponse;
import com.rain.dto.LatencySeriesPoint;
import com.rain.dto.SuccessFailureSeriesPoint;
import com.rain.entity.ApiStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;

@Repository
public class MetricsRepository {

    private final JdbcTemplate jdbcTemplate;

    public MetricsRepository(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public DashboardSummaryResponse getDashboardSummary(Instant cutoff) {
        String sql = """
            SELECT 
                COUNT(*) AS total_checks,
                COUNT(*) FILTER (WHERE success = true) AS successful_checks,
                COUNT(*) FILTER (WHERE success = false) AS failed_checks,
                CASE WHEN COUNT(*) > 0 THEN 
                    (COUNT(*) FILTER (WHERE success = true) * 100.0) / COUNT(*) 
                ELSE NULL END AS overall_check_based_uptime_percentage,
                AVG(latency_ms) AS overall_average_response_latency_ms,
                PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) AS overall_p95_response_latency_ms
            FROM health_checks 
            WHERE checked_at >= ?
        """;

        return jdbcTemplate.queryForObject(sql, (rs, rowNum) -> {
            DashboardSummaryResponse summary = new DashboardSummaryResponse();
            summary.setTotalChecks(rs.getLong("total_checks"));
            summary.setSuccessfulChecks(rs.getLong("successful_checks"));
            summary.setFailedChecks(rs.getLong("failed_checks"));
            
            summary.setOverallCheckBasedUptimePercentage(rs.getObject("overall_check_based_uptime_percentage") != null ? rs.getDouble("overall_check_based_uptime_percentage") : null);
            summary.setOverallAverageResponseLatencyMs(rs.getObject("overall_average_response_latency_ms") != null ? rs.getDouble("overall_average_response_latency_ms") : null);
            summary.setOverallP95ResponseLatencyMs(rs.getObject("overall_p95_response_latency_ms") != null ? rs.getDouble("overall_p95_response_latency_ms") : null);
            return summary;
        }, Timestamp.from(cutoff));
    }

    public ApiMetricsResponse getApiMetrics(Long apiServiceId, Instant cutoff) {
        String sql = """
            SELECT 
                COUNT(*) AS total_checks,
                COUNT(*) FILTER (WHERE success = true) AS successful_checks,
                COUNT(*) FILTER (WHERE success = false) AS failed_checks,
                CASE WHEN COUNT(*) > 0 THEN 
                    (COUNT(*) FILTER (WHERE success = true) * 100.0) / COUNT(*) 
                ELSE NULL END AS uptime_percentage,
                CASE WHEN COUNT(*) > 0 THEN 
                    (COUNT(*) FILTER (WHERE success = false) * 100.0) / COUNT(*) 
                ELSE NULL END AS failure_rate,
                AVG(latency_ms) AS average_response_latency_ms,
                PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_response_latency_ms,
                MAX(checked_at) AS last_checked_at,
                MAX(checked_at) FILTER (WHERE success = true) AS last_successful_at,
                MAX(checked_at) FILTER (WHERE success = false) AS last_failed_at
            FROM health_checks 
            WHERE api_service_id = ? AND checked_at >= ?
        """;

        return jdbcTemplate.queryForObject(sql, (rs, rowNum) -> {
            ApiMetricsResponse response = new ApiMetricsResponse();
            response.setTotalChecks(rs.getLong("total_checks"));
            response.setSuccessfulChecks(rs.getLong("successful_checks"));
            response.setFailedChecks(rs.getLong("failed_checks"));
            
            response.setUptimePercentage(rs.getObject("uptime_percentage") != null ? rs.getDouble("uptime_percentage") : null);
            response.setFailureRate(rs.getObject("failure_rate") != null ? rs.getDouble("failure_rate") : null);
            response.setAverageResponseLatencyMs(rs.getObject("average_response_latency_ms") != null ? rs.getDouble("average_response_latency_ms") : null);
            response.setP95ResponseLatencyMs(rs.getObject("p95_response_latency_ms") != null ? rs.getDouble("p95_response_latency_ms") : null);
            
            Timestamp lastChecked = rs.getTimestamp("last_checked_at");
            response.setLastCheckedAt(lastChecked != null ? lastChecked.toInstant() : null);
            Timestamp lastSuccessful = rs.getTimestamp("last_successful_at");
            response.setLastSuccessfulAt(lastSuccessful != null ? lastSuccessful.toInstant() : null);
            Timestamp lastFailed = rs.getTimestamp("last_failed_at");
            response.setLastFailedAt(lastFailed != null ? lastFailed.toInstant() : null);
            
            return response;
        }, apiServiceId, Timestamp.from(cutoff));
    }

    public List<LatencySeriesPoint> getLatencySeries(Long apiServiceId, Instant cutoff, String postgresInterval) {
        String sql = String.format("""
            SELECT 
                date_trunc('%s', checked_at AT TIME ZONE 'UTC') AS bucket_timestamp,
                AVG(latency_ms) AS average_response_latency_ms,
                PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_response_latency_ms,
                MIN(latency_ms) AS min_response_latency_ms,
                MAX(latency_ms) AS max_response_latency_ms
            FROM health_checks 
            WHERE api_service_id = ? AND checked_at >= ? AND latency_ms IS NOT NULL
            GROUP BY bucket_timestamp
            ORDER BY bucket_timestamp ASC
        """, postgresInterval);

        return jdbcTemplate.query(sql, (rs, rowNum) -> {
            LatencySeriesPoint point = new LatencySeriesPoint();
            // date_trunc with AT TIME ZONE 'UTC' returns TIMESTAMP WITHOUT TIME ZONE in UTC
            // So we need to correctly interpret it as UTC.
            Timestamp ts = rs.getTimestamp("bucket_timestamp");
            point.setTimestamp(ts.toInstant());
            point.setAverageResponseLatencyMs(rs.getDouble("average_response_latency_ms"));
            point.setP95ResponseLatencyMs(rs.getDouble("p95_response_latency_ms"));
            point.setMinResponseLatencyMs(rs.getDouble("min_response_latency_ms"));
            point.setMaxResponseLatencyMs(rs.getDouble("max_response_latency_ms"));
            return point;
        }, apiServiceId, Timestamp.from(cutoff));
    }

    public List<SuccessFailureSeriesPoint> getSuccessFailureSeries(Long apiServiceId, Instant cutoff, String postgresInterval) {
        String sql = String.format("""
            SELECT 
                date_trunc('%s', checked_at AT TIME ZONE 'UTC') AS bucket_timestamp,
                COUNT(*) FILTER (WHERE success = true) AS successful,
                COUNT(*) FILTER (WHERE success = false) AS failed
            FROM health_checks 
            WHERE api_service_id = ? AND checked_at >= ?
            GROUP BY bucket_timestamp
            ORDER BY bucket_timestamp ASC
        """, postgresInterval);

        return jdbcTemplate.query(sql, (rs, rowNum) -> {
            SuccessFailureSeriesPoint point = new SuccessFailureSeriesPoint();
            Timestamp ts = rs.getTimestamp("bucket_timestamp");
            point.setTimestamp(ts.toInstant());
            point.setSuccessful(rs.getLong("successful"));
            point.setFailed(rs.getLong("failed"));
            return point;
        }, apiServiceId, Timestamp.from(cutoff));
    }
}
