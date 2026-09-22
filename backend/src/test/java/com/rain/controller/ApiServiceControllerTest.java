package com.rain.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.rain.dto.ApiServiceRequest;
import com.rain.dto.ApiServiceResponse;
import com.rain.entity.HttpMethod;
import com.rain.exception.ResourceNotFoundException;
import com.rain.service.ApiRegistryService;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(ApiServiceController.class)
public class ApiServiceControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @MockBean
    private ApiRegistryService apiRegistryService;

    @Test
    public void testCreateService_ValidationFailure() throws Exception {
        ApiServiceRequest request = new ApiServiceRequest();
        request.setName(""); // Invalid name
        
        mockMvc.perform(post("/api/services")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(request)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.name").value("Name is required"));
    }

    @Test
    public void testCreateService_Success() throws Exception {
        ApiServiceRequest request = new ApiServiceRequest();
        request.setName("Test API");
        request.setUrl("https://api.example.com");
        request.setMethod(HttpMethod.GET);
        request.setExpectedStatusCode(200);
        request.setTimeoutMs(5000);
        request.setLatencyThresholdMs(1000);
        request.setCheckIntervalSeconds(60);

        ApiServiceResponse response = new ApiServiceResponse();
        response.setId(1L);
        response.setName("Test API");
        
        Mockito.when(apiRegistryService.createService(any(ApiServiceRequest.class))).thenReturn(response);

        mockMvc.perform(post("/api/services")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(request)))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").value(1))
                .andExpect(jsonPath("$.name").value("Test API"));
    }

    @Test
    public void testGetService_NotFound() throws Exception {
        Mockito.when(apiRegistryService.getServiceById(999L))
                .thenThrow(new ResourceNotFoundException("Not found"));

        mockMvc.perform(get("/api/services/999"))
                .andExpect(status().isNotFound());
    }
}
