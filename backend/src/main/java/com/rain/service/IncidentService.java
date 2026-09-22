package com.rain.service;

import com.rain.dto.IncidentDto;
import com.rain.entity.HealthCheck;
import com.rain.entity.Incident;
import com.rain.repository.IncidentRepository;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.stream.Collectors;

@Service
public class IncidentService {

    private final IncidentRepository incidentRepository;

    public IncidentService(IncidentRepository incidentRepository) {
        this.incidentRepository = incidentRepository;
    }

    @Transactional(readOnly = true)
    public List<IncidentDto> getRecentIncidentsForService(Long apiServiceId, int limit) {
        if (limit <= 0 || limit > 50) {
            throw new IllegalArgumentException("Limit must be between 1 and 50");
        }
        return incidentRepository.findRecentByApiServiceId(apiServiceId, PageRequest.of(0, limit))
                .stream()
                .map(this::mapToDto)
                .collect(Collectors.toList());
    }

    @Transactional(readOnly = true)
    public List<IncidentDto> getRecentPlatformIncidents(int limit) {
        if (limit <= 0 || limit > 50) {
            throw new IllegalArgumentException("Limit must be between 1 and 50");
        }
        return incidentRepository.findRecent(PageRequest.of(0, limit))
                .stream()
                .map(this::mapToDto)
                .collect(Collectors.toList());
    }

    private IncidentDto mapToDto(Incident incident) {
        IncidentDto dto = new IncidentDto();
        dto.setId(incident.getId());
        dto.setApiServiceId(incident.getApiService().getId());
        dto.setStatus(incident.getStatus().name());
        dto.setStartedAt(incident.getStartedAt());
        dto.setResolvedAt(incident.getResolvedAt());
        dto.setFailureCount(incident.getFailureCount());

        HealthCheck latest = incident.getLatestHealthCheck();
        if (latest != null) {
            dto.setLatestErrorType(latest.getErrorType());
            dto.setLatestErrorMessage(latest.getErrorMessage());
            dto.setLatestHttpStatus(latest.getHttpStatus());
            dto.setLatestLatencyMs(latest.getLatencyMs());
        }

        return dto;
    }
}
