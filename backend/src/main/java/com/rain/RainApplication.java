package com.rain;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class RainApplication {

	public static void main(String[] args) {
		SpringApplication.run(RainApplication.class, args);
	}

}
