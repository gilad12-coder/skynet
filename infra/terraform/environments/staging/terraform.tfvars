# Lean staging (default). Scale up with -var-file=full.tfvars or edit here.
#
# Railway staging memory peaks (7 days): backend 3.0 GB, worker 2.3 GB,
# litellm 2.6 GB, frontend 0.3 GB. CPU stayed below 0.02 vCPU. One task per
# service carries this load. On-demand Fargate, not Spot: on 2026-10-29 Spot
# had no capacity for hours, and one-task services stayed down.

# Go-live switches. Pass 1 needs both false: secrets, database and an ISSUED
# certificate do not exist yet. Step 8 of the README sets both to true here
# and merges that change, so every later plan and apply keeps the services
# and HTTPS. Setting either one back to false destroys them.
services_enabled = true
enable_https     = true

egress_mode = "public_ip"

db_instance_class = "db.t4g.small"
db_multi_az       = false

cache_node_count = 1

services = {
  backend  = { cpu = 512, memory = 3072, desired_count = 1, spot = false }
  worker   = { cpu = 512, memory = 3072, desired_count = 1, spot = false }
  frontend = { cpu = 256, memory = 512, desired_count = 1, spot = false }
  litellm  = { cpu = 512, memory = 3072, desired_count = 1, spot = false }
}
