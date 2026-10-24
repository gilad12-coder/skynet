# Lean production (default). Scale up with -var-file=full.tfvars or edit here.
#
# Railway production memory (7 days, summed over 3/3/2/2 replicas): backend
# 1.6 GB, worker 1.3 GB, litellm 1.3 GB, frontend 0.3 GB. One task per
# service carries this load. backend and frontend scale out to 3 tasks on CPU.
# Memory is cheap on Fargate (about $2.60 per GB-month), so each task keeps
# headroom above the Railway peaks; vCPU is the main cost.
#
# Availability cost: with one task, a task crash or an AZ outage stops that
# service for 1-3 minutes until ECS starts a replacement. Deploys stay
# zero-downtime (the new task starts before the old one stops).

# Go-live switches. Pass 1 needs both false: secrets, database and an ISSUED
# certificate do not exist yet. Step 8 of the README sets both to true here
# and merges that change, so every later plan and apply keeps the services
# and HTTPS. Setting either one back to false destroys them.
services_enabled = true
enable_https     = true

egress_mode = "nat_single"

db_instance_class = "db.t4g.small"
db_multi_az       = false

cache_node_count = 1

services = {
  backend  = { cpu = 512, memory = 3072, desired_count = 1 }
  worker   = { cpu = 512, memory = 3072, desired_count = 1 }
  frontend = { cpu = 256, memory = 1024, desired_count = 1 }
  litellm  = { cpu = 512, memory = 3072, desired_count = 1 }
}
