package com.rain.monitoring;

import com.rain.entity.ApiService;
import com.rain.entity.ApiStatus;
import com.rain.entity.HealthCheck;
import com.rain.repository.ApiServiceRepository;
import com.rain.repository.HealthCheckRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;

@Service
public class MonitoringEngineService {

    private final HealthCheckExecutor healthCheckExecutor;
    private final HealthCheckRepository healthCheckRepository;
    private final ApiServiceRepository apiServiceRepository;

    public MonitoringEngineService(HealthCheckExecutor healthCheckExecutor,
                                   HealthCheckRepository healthCheckRepository,
                                   ApiServiceRepository apiServiceRepository) {
        this.healthCheckExecutor = healthCheckExecutor;
        this.healthCheckRepository = healthCheckRepository;
        this.apiServiceRepository = apiServiceRepository;
    }

    public HealthCheck executeAndSaveCheck(Long apiServiceId) {
        // Load config (we read it once, and we do NOT hold a transaction open during execution)
        ApiService apiService = apiServiceRepository.findById(apiServiceId).orElse(null);
        if (apiService == null || !apiService.getEnabled()) {
            return null; // Skip if deleted or paused
        }

        // Execute external call
        HealthCheckResult result = healthCheckExecutor.execute(apiService);
        Instant now = Instant.now();

        // Evaluate Status
        ApiStatus newStatus = ApiStatus.DOWN;
        boolean success = false;
        
        if (result.success() && result.httpStatus() == apiService.getExpectedStatusCode()) {
            if (result.latencyMs() <= apiService.getLatencyThresholdMs()) {
                newStatus = ApiStatus.HEALTHY;
                success = true;
            } else {
                newStatus = ApiStatus.DEGRADED;
                success = true;
            }
        } else if (result.success()) {
            // Unexpected HTTP Status
            newStatus = ApiStatus.DOWN;
        } // else DOWN (timeout/error)

        // Save result in a short transaction
        return saveResultAndUpdateStatus(apiServiceId, now, result, newStatus, success);
    }

    @Transactional
    protected HealthCheck saveResultAndUpdateStatus(Long apiServiceId, Instant checkedAt, HealthCheckResult result, ApiStatus newStatus, boolean success) {
        ApiService apiService = apiServiceRepository.findById(apiServiceId).orElse(null);
        if (apiService == null) {
            return null;
        }

        // Create record
        HealthCheck check = new HealthCheck();
        check.setApiService(apiService);
        check.setCheckedAt(checkedAt);
        check.setSuccess(success);
        check.setStatus(newStatus);
        check.setHttpStatus(result.httpStatus() == 0 ? null : result.httpStatus());
        check.setLatencyMs(result.latencyMs());
        
        if (!success) {
            if (result.errorType() != null) {
                check.setErrorType(result.errorType());
                check.setErrorMessage(result.errorMessage());
            } else if (result.httpStatus() != apiService.getExpectedStatusCode()) {
                check.setErrorType("HTTP_STATUS_MISMATCH");
                check.setErrorMessage("Expected " + apiService.getExpectedStatusCode() + " but got " + result.httpStatus());
            }
        }

        HealthCheck saved = healthCheckRepository.save(check);

        // Update API
        apiService.setCurrentStatus(newStatus);
        apiService.setLastCheckedAt(checkedAt);
        apiService.setNextCheckAt(checkedAt.plusSeconds(apiService.getCheckIntervalSeconds()));
        apiServiceRepository.save(apiService);

        return saved;
    }
}
