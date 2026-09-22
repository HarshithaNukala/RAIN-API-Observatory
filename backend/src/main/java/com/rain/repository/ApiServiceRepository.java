package com.rain.repository;

import com.rain.entity.ApiService;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Repository
public interface ApiServiceRepository extends JpaRepository<ApiService, Long> {
    
    @EntityGraph(attributePaths = {"headers"})
    Optional<ApiService> findById(Long id);

    @Query("SELECT a.id FROM ApiService a WHERE a.enabled = true AND (a.nextCheckAt IS NULL OR a.nextCheckAt <= :now)")
    List<Long> findDueApiIds(@Param("now") Instant now);
}
