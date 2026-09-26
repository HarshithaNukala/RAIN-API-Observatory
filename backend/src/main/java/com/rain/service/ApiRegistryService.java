package com.rain.service;

import com.rain.dto.ApiHeaderRequest;
import com.rain.dto.ApiHeaderResponse;
import com.rain.dto.ApiServiceRequest;
import com.rain.dto.ApiServiceResponse;
import com.rain.entity.ApiHeader;
import com.rain.entity.ApiService;
import com.rain.entity.ApiStatus;
import com.rain.exception.ResourceNotFoundException;
import com.rain.repository.ApiServiceRepository;
import com.rain.repository.IncidentRepository;
import com.rain.entity.IncidentStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;

@Service
public class ApiRegistryService {

    private final ApiServiceRepository repository;
    private final IncidentRepository incidentRepository;

    public ApiRegistryService(ApiServiceRepository repository, IncidentRepository incidentRepository) {
        this.repository = repository;
        this.incidentRepository = incidentRepository;
    }

    @Transactional(readOnly = true)
    public List<ApiServiceResponse> getAllServices() {
        java.util.Set<Long> apisWithIncidents = incidentRepository.findApiIdsByStatus(IncidentStatus.OPEN);
        return repository.findAll().stream()
                .map(service -> {
                    ApiServiceResponse response = mapToResponse(service, false);
                    response.setHasActiveIncident(apisWithIncidents.contains(service.getId()));
                    return response;
                })
                .collect(Collectors.toList());
    }

    @Transactional(readOnly = true)
    public ApiServiceResponse getServiceById(Long id) {
        ApiService service = repository.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("API Service not found with id: " + id));
        ApiServiceResponse response = mapToResponse(service, true); // Include safe header metadata
        java.util.Set<Long> apisWithIncidents = incidentRepository.findApiIdsByStatus(IncidentStatus.OPEN);
        response.setHasActiveIncident(apisWithIncidents.contains(service.getId()));
        return response;
    }

    @Transactional
    public ApiServiceResponse createService(ApiServiceRequest request) {
        validateUrl(request.getUrl());
        ApiService service = new ApiService();
        updateEntityFromRequest(service, request);
        service.setEnabled(true);
        service.setCurrentStatus(ApiStatus.UNKNOWN);
        service.setNextCheckAt(java.time.Instant.now());
        ApiService saved = repository.save(service);
        ApiServiceResponse response = mapToResponse(saved, true);
        response.setHasActiveIncident(false); // Brand new service has no incidents
        return response;
    }

    @Transactional
    public ApiServiceResponse updateService(Long id, ApiServiceRequest request) {
        validateUrl(request.getUrl());
        ApiService service = repository.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("API Service not found with id: " + id));
        updateEntityFromRequest(service, request);
        
        // Editing monitoring interval must recalculate next_check_at appropriately
        // If it's enabled, we schedule it immediately to pick up the new interval config
        if (service.getEnabled()) {
            service.setNextCheckAt(java.time.Instant.now());
        }
        
        ApiService saved = repository.save(service);
        ApiServiceResponse response = mapToResponse(saved, true);
        java.util.Set<Long> apisWithIncidents = incidentRepository.findApiIdsByStatus(IncidentStatus.OPEN);
        response.setHasActiveIncident(apisWithIncidents.contains(saved.getId()));
        return response;
    }

    @Transactional
    public void deleteService(Long id) {
        if (!repository.existsById(id)) {
            throw new ResourceNotFoundException("API Service not found with id: " + id);
        }
        repository.deleteById(id);
    }

    @Transactional
    public ApiServiceResponse pauseService(Long id) {
        ApiService service = repository.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("API Service not found with id: " + id));
        service.setEnabled(false);
        service.setCurrentStatus(ApiStatus.PAUSED);
        ApiService saved = repository.save(service);
        ApiServiceResponse response = mapToResponse(saved, true);
        java.util.Set<Long> apisWithIncidents = incidentRepository.findApiIdsByStatus(IncidentStatus.OPEN);
        response.setHasActiveIncident(apisWithIncidents.contains(saved.getId()));
        return response;
    }

    @Transactional
    public ApiServiceResponse resumeService(Long id) {
        ApiService service = repository.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("API Service not found with id: " + id));
        service.setEnabled(true);
        service.setCurrentStatus(ApiStatus.UNKNOWN);
        service.setNextCheckAt(java.time.Instant.now());
        ApiService saved = repository.save(service);
        ApiServiceResponse response = mapToResponse(saved, true);
        java.util.Set<Long> apisWithIncidents = incidentRepository.findApiIdsByStatus(IncidentStatus.OPEN);
        response.setHasActiveIncident(apisWithIncidents.contains(saved.getId()));
        return response;
    }

    private void validateUrl(String urlString) {
        try {
            URI uri = new URI(urlString);
            String scheme = uri.getScheme();
            if (scheme == null || (!scheme.equalsIgnoreCase("http") && !scheme.equalsIgnoreCase("https"))) {
                throw new IllegalArgumentException("URL must use HTTP or HTTPS scheme");
            }
            if (uri.getHost() == null || uri.getHost().trim().isEmpty()) {
                throw new IllegalArgumentException("URL must contain a valid host");
            }
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("Invalid URL format: " + e.getMessage());
        }
    }

    private void updateEntityFromRequest(ApiService service, ApiServiceRequest request) {
        service.setName(request.getName());
        service.setUrl(request.getUrl());
        service.setMethod(request.getMethod());
        service.setDescription(request.getDescription());
        service.setExpectedStatusCode(request.getExpectedStatusCode());
        service.setTimeoutMs(request.getTimeoutMs());
        service.setLatencyThresholdMs(request.getLatencyThresholdMs());
        service.setCheckIntervalSeconds(request.getCheckIntervalSeconds());
        service.setRequestBody(request.getRequestBody());

        // Update headers
        service.setHeaders(null); // Clears existing headers
        if (request.getHeaders() != null) {
            List<ApiHeader> newHeaders = new ArrayList<>();
            for (ApiHeaderRequest hr : request.getHeaders()) {
                ApiHeader header = new ApiHeader(service, hr.getHeaderName(), hr.getHeaderValue());
                newHeaders.add(header);
            }
            service.setHeaders(newHeaders);
        }
    }

    private ApiServiceResponse mapToResponse(ApiService service, boolean includeHeaders) {
        ApiServiceResponse response = new ApiServiceResponse();
        response.setId(service.getId());
        response.setName(service.getName());
        response.setUrl(service.getUrl());
        response.setMethod(service.getMethod());
        response.setDescription(service.getDescription());
        response.setExpectedStatusCode(service.getExpectedStatusCode());
        response.setTimeoutMs(service.getTimeoutMs());
        response.setLatencyThresholdMs(service.getLatencyThresholdMs());
        response.setCheckIntervalSeconds(service.getCheckIntervalSeconds());
        response.setEnabled(service.getEnabled());
        response.setCurrentStatus(service.getCurrentStatus());
        response.setCreatedAt(service.getCreatedAt());
        response.setUpdatedAt(service.getUpdatedAt());
        response.setRequestBody(service.getRequestBody());
        response.setLastCheckedAt(service.getLastCheckedAt());
        response.setNextCheckAt(service.getNextCheckAt());

        if (includeHeaders && service.getHeaders() != null) {
            List<ApiHeaderResponse> headerResponses = service.getHeaders().stream()
                    .map(h -> new ApiHeaderResponse(h.getHeaderName(), true)) // Safe metadata only
                    .collect(Collectors.toList());
            response.setHeaders(headerResponses);
        }

        return response;
    }
}
