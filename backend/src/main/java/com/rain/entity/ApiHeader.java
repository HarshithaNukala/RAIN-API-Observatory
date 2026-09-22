package com.rain.entity;

import jakarta.persistence.*;
import java.util.Objects;

@Entity
@Table(name = "api_headers")
public class ApiHeader {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "api_service_id", nullable = false)
    private ApiService apiService;

    @Column(name = "header_name", nullable = false)
    private String headerName;

    @Column(name = "header_value", nullable = false, length = 4096)
    private String headerValue;

    public ApiHeader() {
    }

    public ApiHeader(ApiService apiService, String headerName, String headerValue) {
        this.apiService = apiService;
        this.headerName = headerName;
        this.headerValue = headerValue;
    }

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public ApiService getApiService() {
        return apiService;
    }

    public void setApiService(ApiService apiService) {
        this.apiService = apiService;
    }

    public String getHeaderName() {
        return headerName;
    }

    public void setHeaderName(String headerName) {
        this.headerName = headerName;
    }

    public String getHeaderValue() {
        return headerValue;
    }

    public void setHeaderValue(String headerValue) {
        this.headerValue = headerValue;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof ApiHeader)) return false;
        ApiHeader apiHeader = (ApiHeader) o;
        return Objects.equals(id, apiHeader.id);
    }

    @Override
    public int hashCode() {
        return Objects.hash(id);
    }
}
