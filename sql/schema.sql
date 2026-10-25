CREATE TABLE IF NOT EXISTS app_users (
  id VARCHAR(64) PRIMARY KEY,
  email VARCHAR(254) NULL,
  phone_e164 VARCHAR(16) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_app_users_email (email),
  UNIQUE KEY uq_app_users_phone (phone_e164)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash CHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_oauth_states_expiry (expires_at),
  CONSTRAINT fk_oauth_states_user FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS google_credentials (
  user_id VARCHAR(64) PRIMARY KEY,
  encrypted_tokens MEDIUMTEXT NOT NULL,
  scopes TEXT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_google_credentials_user FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS whatsapp_contacts (
  phone_e164 VARCHAR(16) PRIMARY KEY,
  opted_in BOOLEAN NOT NULL DEFAULT FALSE,
  ai_opted_in BOOLEAN NOT NULL DEFAULT FALSE,
  consent_source VARCHAR(128) NULL,
  consented_at DATETIME NULL,
  last_inbound_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  provider_message_id VARCHAR(128) NOT NULL,
  phone_e164 VARCHAR(16) NOT NULL,
  direction ENUM('inbound','outbound') NOT NULL,
  message_type VARCHAR(32) NOT NULL DEFAULT 'text',
  body TEXT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'received',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_whatsapp_provider_message (provider_message_id),
  KEY idx_whatsapp_phone_created (phone_e164, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
