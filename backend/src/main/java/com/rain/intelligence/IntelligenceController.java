package com.rain.intelligence;

import com.rain.intelligence.dto.ServiceIntelligenceResponse;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/services")
public class IntelligenceController {

    private final IntelligenceService intelligenceService;

    public IntelligenceController(IntelligenceService intelligenceService) {
        this.intelligenceService = intelligenceService;
    }

    @GetMapping("/{id}/intelligence")
    public ResponseEntity<ServiceIntelligenceResponse> getIntelligence(
            @PathVariable Long id,
            @RequestParam(defaultValue = "7d") String window) {
        
        try {
            ServiceIntelligenceResponse response = intelligenceService.getIntelligence(id, window);
            return ResponseEntity.ok(response);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().build();
        } catch (RuntimeException e) {
            if ("API not found".equals(e.getMessage())) {
                return ResponseEntity.notFound().build();
            }
            return ResponseEntity.internalServerError().build();
        }
    }
}
