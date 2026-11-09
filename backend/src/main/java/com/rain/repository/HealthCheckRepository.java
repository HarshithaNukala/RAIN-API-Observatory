package com.rain.repository;

import com.rain.entity.HealthCheck;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface HealthCheckRepository extends JpaRepository<HealthCheck, Long> {

    List<HealthCheck> findByApiServiceIdAndCheckedAtBetweenOrderByCheckedAtDesc(Long apiServiceId, java.time.Instant start, java.time.Instant end);

    List<HealthCheck> findTop50ByApiServiceIdAndCheckedAtLessThanAndSuccessTrueAndLatencyMsIsNotNullOrderByCheckedAtDesc(Long apiServiceId, java.time.Instant checkedAt);
}
