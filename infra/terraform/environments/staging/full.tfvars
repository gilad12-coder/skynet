# Full staging: on-demand tasks behind one NAT gateway.
# Use: terraform plan|apply -var-file=full.tfvars (overrides terraform.tfvars).

egress_mode = "nat_single"

db_instance_class = "db.t4g.small"
db_multi_az       = false

cache_node_count = 1

services = {
  backend  = { cpu = 512, memory = 3072, desired_count = 1 }
  worker   = { cpu = 512, memory = 3072, desired_count = 1 }
  frontend = { cpu = 256, memory = 512, desired_count = 1 }
  litellm  = { cpu = 512, memory = 3072, desired_count = 1 }
}
