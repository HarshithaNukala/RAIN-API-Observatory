package com.rain.repository;

import com.rain.entity.ApiService;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface ApiServiceRepository extends JpaRepository<ApiService, Long> {
}
