'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface IdentityBrokerApp {
  appId: string;
  name: string;
  type: string;
  clientId: string;
  clientIdFingerprint: string;
  secretUpdatedAt?: string;
  previousSecretExpiresAt?: string;
  redirectUris: string[];
  allowedOrigins: string[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  displayName?: string;
  emailFromName?: string;
  emailSubject?: string;
  emailTagline?: string;
  emailPrimaryColor?: string;
  emailLogoUrl?: string;
  appUrl?: string;
}

export type IdentityBrokerLookup =
  | { registered: true; app: IdentityBrokerApp }
  | { registered: false };

export function useIdentityBrokerApp(appId: string | null | undefined) {
  return useQuery({
    queryKey: ['identity-broker', 'apps', appId],
    queryFn: () => api.get<IdentityBrokerLookup>(`/identity-broker/apps/${appId}`),
    enabled: !!appId,
  });
}

export type DriftStatus = 'in_sync' | 'drift' | 'no_local_secret' | 'broker_missing';

export interface DriftReport {
  status: DriftStatus;
  detail: string;
  appId: string;
  brokerClientId?: string;
  brokerFingerprint?: string;
  localClientId?: string;
  localFingerprint?: string;
  brokerSecretUpdatedAt?: string;
  localSecretWrittenAt?: string;
  secretName: string;
  secretArn?: string;
  previousSecretExpiresAt?: string;
}

export function useIdentityBrokerDrift(appId: string | null | undefined) {
  return useQuery({
    queryKey: ['identity-broker', 'apps', appId, 'drift'],
    queryFn: () => api.get<DriftReport>(`/identity-broker/apps/${appId}/drift`),
    enabled: !!appId,
  });
}

export interface RegisterAppInput {
  name: string;
  type?: 'web' | 'mobile' | 'service';
  baseUrl?: string;
  redirectUris?: string[];
  allowedOrigins?: string[];
}

export interface RegisterAppResult {
  alreadyExisted: boolean;
  appId: string;
  clientId: string;
  clientIdFingerprint: string;
  createdAt: string;
  secretArn: string;
  secretName: string;
  secretWritten: boolean;
  config: {
    name: string;
    type: string;
    redirectUris: string[];
    allowedOrigins: string[];
  };
}

export function useRegisterIdentityBrokerApp(appId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RegisterAppInput) =>
      api.post<RegisterAppResult>(`/identity-broker/apps/${appId}`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['identity-broker', 'apps', appId] });
    },
  });
}

export interface RotateAppResult {
  appId: string;
  clientId: string;
  clientIdFingerprint: string;
  rotatedAt: string;
  previousSecretExpiresAt: string;
  secretArn: string;
  secretName: string;
}

export function useRotateIdentityBrokerApp(appId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<RotateAppResult>(`/identity-broker/apps/${appId}/rotate`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['identity-broker', 'apps', appId] });
    },
  });
}
