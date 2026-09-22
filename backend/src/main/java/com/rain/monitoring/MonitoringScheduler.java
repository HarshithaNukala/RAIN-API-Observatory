package com.rain.monitoring;

import com.rain.repository.ApiServiceRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;

@Component
public class MonitoringScheduler {

    private static final Logger log = LoggerFactory.getLogger(MonitoringScheduler.class);

    private final ApiServiceRepository apiServiceRepository;
    private final MonitoringEngineService monitoringEngineService;
    private final Semaphore concurrencyLimiter;
    private final ExecutorService virtualThreadExecutor;
    
    // Tracks APIs currently being checked to prevent duplicate execution
    private final Set<Long> activeChecks = ConcurrentHashMap.newKeySet();

    public MonitoringScheduler(ApiServiceRepository apiServiceRepository,
                               MonitoringEngineService monitoringEngineService,
                               @Value("${rain.monitoring.max-concurrency:100}") int maxConcurrency) {
        this.apiServiceRepository = apiServiceRepository;
        this.monitoringEngineService = monitoringEngineService;
        this.concurrencyLimiter = new Semaphore(maxConcurrency);
        this.virtualThreadExecutor = Executors.newVirtualThreadPerTaskExecutor();
    }

    @Scheduled(fixedDelayString = "${rain.monitoring.dispatcher-interval:1000}")
    public void dispatchDueChecks() {
        List<Long> dueApiIds = apiServiceRepository.findDueApiIds(Instant.now());
        
        for (Long apiId : dueApiIds) {
            // Duplicate Check Prevention: Only claim if it's not already actively running
            if (activeChecks.add(apiId)) {
                
                // Submit task to Virtual Thread Executor if we can acquire a permit
                if (concurrencyLimiter.tryAcquire()) {
                    virtualThreadExecutor.submit(() -> {
                        try {
                            log.info("Starting scheduled monitoring check for API {}", apiId);
                            monitoringEngineService.executeAndSaveCheck(apiId);
                        } catch (Exception e) {
                            log.error("Unhandled error during check for API {}: {}", apiId, e.getMessage());
                        } finally {
                            activeChecks.remove(apiId);
                            concurrencyLimiter.release();
                        }
                    });
                } else {
                    // Could not acquire permit. We must remove from activeChecks so it gets picked up later.
                    activeChecks.remove(apiId);
                    log.warn("Monitoring concurrency limit reached. Skipping API {} until next tick.", apiId);
                }
            }
        }
    }
}
