package com.rain.controller;

import com.rain.dto.ApiServiceRequest;
import com.rain.dto.ApiServiceResponse;
import com.rain.entity.HealthCheck;
import com.rain.monitoring.MonitoringEngineService;
import com.rain.service.ApiRegistryService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/services")
public class ApiServiceController {

    private final ApiRegistryService apiRegistryService;
    private final MonitoringEngineService monitoringEngineService;

    public ApiServiceController(ApiRegistryService apiRegistryService, MonitoringEngineService monitoringEngineService) {
        this.apiRegistryService = apiRegistryService;
        this.monitoringEngineService = monitoringEngineService;
    }

    @GetMapping
    public ResponseEntity<List<ApiServiceResponse>> getAllServices() {
        return ResponseEntity.ok(apiRegistryService.getAllServices());
    }

    @GetMapping("/{id}")
    public ResponseEntity<ApiServiceResponse> getServiceById(@PathVariable Long id) {
        return ResponseEntity.ok(apiRegistryService.getServiceById(id));
    }

    @PostMapping
    public ResponseEntity<ApiServiceResponse> createService(@Valid @RequestBody ApiServiceRequest request) {
        ApiServiceResponse response = apiRegistryService.createService(request);
        return ResponseEntity.status(HttpStatus.CREATED).body(response);
    }

    @PutMapping("/{id}")
    public ResponseEntity<ApiServiceResponse> updateService(@PathVariable Long id, @Valid @RequestBody ApiServiceRequest request) {
        return ResponseEntity.ok(apiRegistryService.updateService(id, request));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deleteService(@PathVariable Long id) {
        apiRegistryService.deleteService(id);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/{id}/pause")
    public ResponseEntity<ApiServiceResponse> pauseService(@PathVariable Long id) {
        return ResponseEntity.ok(apiRegistryService.pauseService(id));
    }

    @PostMapping("/{id}/resume")
    public ResponseEntity<ApiServiceResponse> resumeService(@PathVariable Long id) {
        return ResponseEntity.ok(apiRegistryService.resumeService(id));
    }

    @PostMapping("/{id}/check")
    public ResponseEntity<?> manualCheck(@PathVariable Long id) {
        HealthCheck result = monitoringEngineService.executeAndSaveCheck(id);
        if (result == null) {
            return ResponseEntity.badRequest().body("API is disabled or not found.");
        }
        return ResponseEntity.ok(result);
    }
}
