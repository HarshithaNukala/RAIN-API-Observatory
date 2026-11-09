package com.rain.intelligence;

import com.rain.entity.ApiService;
import com.rain.entity.HealthCheck;
import com.rain.entity.Incident;
import com.rain.entity.IncidentStatus;
import com.rain.intelligence.dto.AnomalyDto;
import com.rain.intelligence.dto.ErrorTypeDto;
import com.rain.intelligence.dto.ServiceIntelligenceResponse;
import com.rain.repository.ApiServiceRepository;
import com.rain.repository.HealthCheckRepository;
import com.rain.repository.IncidentRepository;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Service
public class IntelligenceService {

    private final HealthCheckRepository healthCheckRepository;
    private final IncidentRepository incidentRepository;
    private final ApiServiceRepository apiServiceRepository;

    public IntelligenceService(HealthCheckRepository healthCheckRepository,
                               IncidentRepository incidentRepository,
                               ApiServiceRepository apiServiceRepository) {
        this.healthCheckRepository = healthCheckRepository;
        this.incidentRepository = incidentRepository;
        this.apiServiceRepository = apiServiceRepository;
    }

    public ServiceIntelligenceResponse getIntelligence(Long apiServiceId, String window) {
        ApiService apiService = apiServiceRepository.findById(apiServiceId)
                .orElseThrow(() -> new RuntimeException("API not found"));

        Instant now = Instant.now();
        long windowSeconds = parseWindow(window);
        Instant start = now.minusSeconds(windowSeconds);
        Instant previousStart = start.minusSeconds(windowSeconds);

        List<HealthCheck> currentChecks = healthCheckRepository.findByApiServiceIdAndCheckedAtBetweenOrderByCheckedAtDesc(apiServiceId, start, now);
        List<HealthCheck> previousChecks = healthCheckRepository.findByApiServiceIdAndCheckedAtBetweenOrderByCheckedAtDesc(apiServiceId, previousStart, start);

        ServiceIntelligenceResponse response = new ServiceIntelligenceResponse();

        Double currentScore = calculateReliabilityScore(currentChecks, apiService.getLatencyThresholdMs());
        Double previousScore = calculateReliabilityScore(previousChecks, apiService.getLatencyThresholdMs());

        response.setReliabilityScore(currentScore);
        response.setScoreTrend(determineTrend(currentScore, previousScore));

        List<HealthCheck> historicalBaseline = healthCheckRepository.findTop50ByApiServiceIdAndCheckedAtLessThanAndSuccessTrueAndLatencyMsIsNotNullOrderByCheckedAtDesc(apiServiceId, start);
        List<HealthCheck> allValidChecks = new ArrayList<>();
        allValidChecks.addAll(currentChecks.stream().filter(hc -> hc.getSuccess() && hc.getLatencyMs() != null).collect(Collectors.toList()));
        allValidChecks.addAll(historicalBaseline);
        allValidChecks.sort((a, b) -> b.getCheckedAt().compareTo(a.getCheckedAt()));

        List<AnomalyDto> anomalies = detectAnomalies(currentChecks, allValidChecks);
        response.setAnomalies(anomalies);
        response.setTotalAnomalies(anomalies.size());

        response.setTopErrorTypes(calculateTopErrorTypes(currentChecks));
        response.setAvgRecoveryTimeMs(calculateAvgRecoveryTime(apiServiceId, start, now));
        response.setRootCauseHints(generateRootCauseHints(apiServiceId, currentChecks, allValidChecks, start, now));

        return response;
    }

    private Double calculateReliabilityScore(List<HealthCheck> checks, Integer thresholdMs) {
        if (checks.isEmpty()) {
            return null;
        }
        long totalChecks = checks.size();
        long successfulChecks = checks.stream().filter(HealthCheck::getSuccess).count();

        double availability = (double) successfulChecks / totalChecks;

        List<HealthCheck> checksWithLatency = checks.stream()
                .filter(hc -> hc.getSuccess() && hc.getLatencyMs() != null)
                .collect(Collectors.toList());

        double latencyCompliance = 1.0;
        if (!checksWithLatency.isEmpty()) {
            long compliantChecks = checksWithLatency.stream()
                    .filter(hc -> hc.getLatencyMs() <= thresholdMs)
                    .count();
            latencyCompliance = (double) compliantChecks / checksWithLatency.size();
        }

        return 100.0 * (0.70 * availability + 0.30 * latencyCompliance);
    }

    private String determineTrend(Double current, Double previous) {
        if (previous == null || current == null) {
            return null;
        }
        if (current > previous + 2.0) {
            return "IMPROVING";
        } else if (current < previous - 2.0) {
            return "DECLINING";
        } else {
            return "STABLE";
        }
    }

    private List<AnomalyDto> detectAnomalies(List<HealthCheck> currentChecks, List<HealthCheck> allValidChecks) {
        List<AnomalyDto> anomalies = new ArrayList<>();
        if (currentChecks.isEmpty()) {
            return anomalies;
        }

        for (HealthCheck check : currentChecks) {
            if (!check.getSuccess() || check.getLatencyMs() == null) {
                continue;
            }

            // Find preceding checks
            List<HealthCheck> baseline = new ArrayList<>();
            for (HealthCheck hc : allValidChecks) {
                if (hc.getCheckedAt().isBefore(check.getCheckedAt())) {
                    baseline.add(hc);
                    if (baseline.size() == 50) {
                        break;
                    }
                }
            }

            if (baseline.size() < 10) {
                continue; // Insufficient history
            }

            double sum = 0;
            for (HealthCheck hc : baseline) {
                sum += hc.getLatencyMs();
            }
            double mu = sum / baseline.size();

            double varianceSum = 0;
            for (HealthCheck hc : baseline) {
                varianceSum += Math.pow(hc.getLatencyMs() - mu, 2);
            }
            double variance = varianceSum / baseline.size();
            double sigma = Math.sqrt(variance);

            double threshold = sigma == 0 ? mu * 1.5 : mu + (3 * sigma);

            if (check.getLatencyMs() > threshold) {
                anomalies.add(new AnomalyDto(check.getId(), check.getCheckedAt(), check.getLatencyMs(), mu, sigma));
            }
        }
        return anomalies;
    }

    private List<ErrorTypeDto> calculateTopErrorTypes(List<HealthCheck> checks) {
        List<HealthCheck> failedChecks = checks.stream().filter(hc -> !hc.getSuccess()).collect(Collectors.toList());
        if (failedChecks.isEmpty()) {
            return new ArrayList<>();
        }

        Map<String, Long> counts = new HashMap<>();
        for (HealthCheck hc : failedChecks) {
            String type = hc.getErrorType() != null ? hc.getErrorType() : "UNKNOWN";
            counts.put(type, counts.getOrDefault(type, 0L) + 1);
        }

        List<ErrorTypeDto> result = new ArrayList<>();
        for (Map.Entry<String, Long> entry : counts.entrySet()) {
            double percentage = (entry.getValue() * 100.0) / failedChecks.size();
            result.add(new ErrorTypeDto(entry.getKey(), entry.getValue(), percentage));
        }

        result.sort((a, b) -> b.getCount().compareTo(a.getCount()));
        return result;
    }

    private Long calculateAvgRecoveryTime(Long apiId, Instant start, Instant end) {
        List<Incident> incidents = incidentRepository.findByApiServiceIdAndStatusAndResolvedAtBetween(apiId, IncidentStatus.RESOLVED, start, end);
        if (incidents.isEmpty()) {
            return null;
        }

        long totalDurationMs = 0;
        int validCount = 0;
        for (Incident incident : incidents) {
            long duration = incident.getResolvedAt().toEpochMilli() - incident.getStartedAt().toEpochMilli();
            if (duration > 0) {
                totalDurationMs += duration;
                validCount++;
            }
        }

        if (validCount == 0) return null;
        return totalDurationMs / validCount;
    }

    private List<String> generateRootCauseHints(Long apiId, List<HealthCheck> currentChecks, List<HealthCheck> allValidChecks, Instant start, Instant end) {
        List<String> hints = new ArrayList<>();

        List<HealthCheck> failedChecks = currentChecks.stream().filter(hc -> !hc.getSuccess()).collect(Collectors.toList());
        if (!failedChecks.isEmpty()) {
            Map<String, Long> counts = new HashMap<>();
            for (HealthCheck hc : failedChecks) {
                String type = hc.getErrorType() != null ? hc.getErrorType() : "UNKNOWN";
                counts.put(type, counts.getOrDefault(type, 0L) + 1);
            }

            for (Map.Entry<String, Long> entry : counts.entrySet()) {
                double percentage = (entry.getValue() * 100.0) / failedChecks.size();
                if (percentage >= 80.0) {
                    hints.add(String.format("Evidence indicates repeated %s failures (%.1f%% of failures).", entry.getKey(), percentage));
                }
            }
        }

        // Preceding-latency rule
        List<Incident> incidents = incidentRepository.findRecentByApiServiceId(apiId, org.springframework.data.domain.PageRequest.of(0, 50));
        boolean degradationFound = false;

        List<HealthCheck> successfulChecksInWindow = currentChecks.stream()
                .filter(hc -> hc.getSuccess() && hc.getLatencyMs() != null)
                .collect(Collectors.toList());

        if (!successfulChecksInWindow.isEmpty()) {
            double globalAvg = successfulChecksInWindow.stream().mapToInt(HealthCheck::getLatencyMs).average().orElse(0);

            for (Incident incident : incidents) {
                if (incident.getStartedAt().isBefore(start) || incident.getStartedAt().isAfter(end)) {
                    continue;
                }
                
                List<HealthCheck> precedingChecks = new ArrayList<>();
                for (HealthCheck hc : allValidChecks) {
                    if (hc.getCheckedAt().isBefore(incident.getStartedAt())) {
                        precedingChecks.add(hc);
                        if (precedingChecks.size() == 10) {
                            break;
                        }
                    }
                }
                
                if (precedingChecks.size() >= 10) {
                    double precedingAvg = precedingChecks.stream().mapToInt(HealthCheck::getLatencyMs).average().orElse(0);
                    if (precedingAvg > 2 * globalAvg && globalAvg > 0) {
                        degradationFound = true;
                        break;
                    }
                }
            }
        }

        if (degradationFound) {
            hints.add("Evidence indicates significant latency degradation preceding recent incidents.");
        }

        return hints;
    }

    private long parseWindow(String window) {
        if (window == null) return 7 * 24 * 3600;
        return switch (window) {
            case "1h" -> 3600;
            case "6h" -> 6 * 3600;
            case "24h" -> 24 * 3600;
            case "7d" -> 7 * 24 * 3600;
            case "30d" -> 30 * 24 * 3600;
            default -> throw new IllegalArgumentException("Invalid window parameter. Supported values: 1h, 6h, 24h, 7d, 30d");
        };
    }
}
