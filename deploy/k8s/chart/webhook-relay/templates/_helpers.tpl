{{- define "relay.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "relay.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "relay.selectorLabels" -}}
app.kubernetes.io/name: {{ include "relay.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Selector of the web pods only (Service, PDB, Deployment): the migration and scheduler pods
share the instance labels but must never receive traffic or count for the PDB. */}}
{{- define "relay.webSelectorLabels" -}}
{{ include "relay.selectorLabels" . }}
app.kubernetes.io/component: web
{{- end -}}

{{- define "relay.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{ include "relay.selectorLabels" . }}
app.kubernetes.io/version: {{ include "relay.tag" . | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "relay.tag" -}}
{{- default .Chart.AppVersion .Values.image.tag -}}
{{- end -}}

{{- define "relay.image" -}}
{{- printf "%s:%s" .Values.image.repository (include "relay.tag" .) -}}
{{- end -}}

{{- define "relay.migrationImage" -}}
{{- printf "%s:%s" .Values.migration.image.repository (default (include "relay.tag" .) .Values.migration.image.tag) -}}
{{- end -}}

{{- define "relay.schedulerImage" -}}
{{- printf "%s:%s" (default .Values.image.repository .Values.scheduler.image.repository) (default (include "relay.tag" .) .Values.scheduler.image.tag) -}}
{{- end -}}

{{- define "relay.secretName" -}}
{{- default (printf "%s-secrets" (include "relay.fullname" .)) .Values.secrets.existingSecret -}}
{{- end -}}

{{- define "relay.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "relay.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* DATABASE_URL for the app and the migration Job. The password is not part of the URL (no
URL-encoding problem with any character): node-postgres reads it from PGPASSWORD, which comes
straight from the database Secret. */}}
{{- define "relay.databaseEnv" -}}
{{- if .Values.database.urlSecret.name }}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.database.urlSecret.name }}
      key: {{ .Values.database.urlSecret.key }}
{{- else }}
- name: PGPASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ required "database.passwordSecret.name is required" .Values.database.passwordSecret.name }}
      key: {{ .Values.database.passwordSecret.key }}
- name: DATABASE_URL
  value: {{ printf "postgres://%s@%s:%v/%s" .Values.database.user .Values.database.host .Values.database.port .Values.database.name | quote }}
{{- end }}
{{- end -}}

{{- define "relay.podSecurity" -}}
automountServiceAccountToken: false
securityContext:
  {{- toYaml .Values.podSecurityContext | nindent 2 }}
{{- end -}}
