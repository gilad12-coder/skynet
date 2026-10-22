# Full production: two tasks per service, Multi-AZ RDS, two Valkey nodes with
# automatic failover, one NAT gateway per AZ.
# Use: terraform plan|apply -var-file=full.tfvars (overrides terraform.tfvars).

egress_mode = "nat_per_az"

db_instance_class = "db.t4g.medium"
db_multi_az       = true

cache_node_count = 2

services = {
  backend  = { cpu = 1024, memory = 2048, desired_count = 2 }
  worker   = { cpu = 1024, memory = 2048, desired_count = 2 }
  frontend = { cpu = 512, memory = 1024, desired_count = 2 }
  litellm  = { cpu = 512, memory = 2048, desired_count = 2 }
}
