import { Module } from '@nestjs/common';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { AuthService } from '../identity/auth.service';
import { OidcDiscoveryService } from './oidc-discovery.service';
import { SsoController } from './sso.controller';
import { SsoLoginController } from './sso-login.controller';
import { SsoService } from './sso.service';

/**
 * Enterprise SSO (docs/31 §1). OIDC only — see docs/31 §5 for why SAML is
 * named and refused rather than quietly missing.
 *
 * `AuthService` and `FieldEncryptionService` are re-provided here rather than
 * imported from a module that exports them: both are registered directly in
 * AppModule (they predate any module boundary around identity), and both are
 * stateless, so a second instance is a second object and not a second pool or
 * a second cache. `OidcDiscoveryService` is the one thing here that holds
 * state, and it lives in exactly one place.
 */
@Module({
  controllers: [SsoController, SsoLoginController],
  providers: [SsoService, OidcDiscoveryService, AuthService, FieldEncryptionService],
})
export class SsoModule {}
