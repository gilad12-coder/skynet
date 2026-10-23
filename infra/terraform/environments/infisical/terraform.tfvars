# Infisical root. No secret goes in this file.
#
# First apply: service_running = false (INFISICAL.md step 1).
# Step 3: Gilad sets smtp_from_address to a sender on a domain that is
# verified in Resend. Terraform refuses service_running = true until then.
# Step 4: service_running = true.
# After Gilad creates the project (step 9): infisical_project_id = "<uuid>".
# Before any sync is enabled (step 12): alert_email.

service_running      = false
infisical_project_id = ""
smtp_from_address    = ""
alert_email          = ""
