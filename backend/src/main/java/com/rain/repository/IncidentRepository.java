package com.rain.repository;

import com.rain.entity.Incident;
import com.rain.entity.IncidentStatus;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface IncidentRepository extends JpaRepository<Incident, Long> {

    Optional<Incident> findTopByApiServiceIdAndStatusOrderByIdDesc(Long apiServiceId, IncidentStatus status);

    @Query("SELECT i FROM Incident i JOIN FETCH i.latestHealthCheck WHERE i.apiService.id = :apiServiceId ORDER BY i.startedAt DESC")
    List<Incident> findRecentByApiServiceId(@Param("apiServiceId") Long apiServiceId, Pageable pageable);

    @Query("SELECT i FROM Incident i JOIN FETCH i.latestHealthCheck ORDER BY i.startedAt DESC")
    List<Incident> findRecent(Pageable pageable);
}
