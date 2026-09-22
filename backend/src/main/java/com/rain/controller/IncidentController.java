package com.rain.controller;

import com.rain.dto.IncidentDto;
import com.rain.repository.ApiServiceRepository;
import com.rain.service.IncidentService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api")
@CrossOrigin(origins = "*")
public class IncidentController {

    private final IncidentService incidentService;
    private final ApiServiceRepository apiServiceRepository;

    public IncidentController(IncidentService incidentService, ApiServiceRepository apiServiceRepository) {
        this.incidentService = incidentService;
        this.apiServiceRepository = apiServiceRepository;
    }

    @GetMapping("/services/{id}/incidents")
    public ResponseEntity<List<IncidentDto>> getRecentIncidentsForService(
            @PathVariable Long id,
            @RequestParam(defaultValue = "50") int limit) {
        
        if (!apiServiceRepository.existsById(id)) {
            return ResponseEntity.notFound().build();
        }

        try {
            List<IncidentDto> incidents = incidentService.getRecentIncidentsForService(id, limit);
            return ResponseEntity.ok(incidents);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().build();
        }
    }

    @GetMapping("/incidents")
    public ResponseEntity<List<IncidentDto>> getRecentPlatformIncidents(
            @RequestParam(defaultValue = "50") int limit) {
        try {
            List<IncidentDto> incidents = incidentService.getRecentPlatformIncidents(limit);
            return ResponseEntity.ok(incidents);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().build();
        }
    }
}
