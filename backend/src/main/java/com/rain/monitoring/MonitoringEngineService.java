package com.rain.monitoring;

import com.rain.entity.ApiService;
import com.rain.entity.ApiStatus;
import com.rain.entity.HealthCheck;
import com.rain.entity.Incident;
import com.rain.entity.IncidentStatus;
import com.rain.repository.ApiServiceRepository;
import com.rain.repository.HealthCheckRepository;
import com.rain.repository.IncidentRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Lazy;

import java.time.Instant;

@Service
public class MonitoringEngineService {

    private final HealthCheckExecutor healthCheckExecutor;
    private final HealthCheckRepository healthCheckRepository;
    private final ApiServiceRepository apiServiceRepository;
    private final IncidentRepository incidentRepository;

    @Autowired
    @Lazy
    private MonitoringEngineService self;

    public MonitoringEngineService(HealthCheckExecutor healthCheckExecutor,
                                   HealthCheckRepository healthCheckRepository,
                                   ApiServiceRepository apiServiceRepository,
                                   IncidentRepository incidentRepository) {
        this.healthCheckExecutor = healthCheckExecutor;
        this.healthCheckRepository = healthCheckRepository;
        this.apiServiceRepository = apiServiceRepository;
        this.incidentRepository = incidentRepository;
    }

    // For unit testing only
    void setSelf(MonitoringEngineService self) {
        this.self = self;
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

        // Save result in a short transaction via self-proxy
        return self.saveResultAndUpdateStatus(apiServiceId, now, result, newStatus, success);
    }

    @Transactional
    protected HealthCheck saveResultAndUpdateStatus(Long apiServiceId, Instant checkedAt, HealthCheckResult result, ApiStatus newStatus, boolean success) {
        // MUST acquire pessimistic write lock first to serialize
        ApiService apiService = apiServiceRepository.findWithLockById(apiServiceId).orElse(null);
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

        // Evaluate Incident Lifecycle
        Incident openIncident = incidentRepository.findTopByApiServiceIdAndStatusOrderByIdDesc(apiServiceId, IncidentStatus.OPEN).orElse(null);
        
        if (!success) {
            if (openIncident == null) {
                Incident newIncident = new Incident();
                newIncident.setApiService(apiService);
                newIncident.setStatus(IncidentStatus.OPEN);
                newIncident.setStartedAt(checkedAt); // Real observation time
                newIncident.setFirstHealthCheck(saved);
                newIncident.setLatestHealthCheck(saved);
                newIncident.setFailureCount(1);
                incidentRepository.save(newIncident);
            } else {
                openIncident.setLatestHealthCheck(saved);
                openIncident.setFailureCount(openIncident.getFailureCount() + 1);
                incidentRepository.save(openIncident);
            }
        } else {
            if (openIncident != null) {
                openIncident.setStatus(IncidentStatus.RESOLVED);
                openIncident.setResolvedAt(checkedAt); // Real observation time
                incidentRepository.save(openIncident);
            }
        }

        // Update API
        apiService.setCurrentStatus(newStatus);
        apiService.setLastCheckedAt(checkedAt);
        apiService.setNextCheckAt(checkedAt.plusSeconds(apiService.getCheckIntervalSeconds()));
        apiServiceRepository.save(apiService);

        return saved;
    }
}
