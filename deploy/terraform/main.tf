# UNTESTED example: run FleetPulse on one AWS VM. The app has no cloud-specific code, so the same
# `node server.js` works on any VM (Azure, GCP) with Node 22; only this file would change.
terraform {
  required_providers { aws = { source = "hashicorp/aws", version = "~> 5.0" } }
}
variable "region"   { default = "ap-south-1" }
variable "ami_id"   { description = "Ubuntu 24.04 AMI id for the region" }
variable "repo_url" { description = "Git URL of this project" }
variable "my_ip_cidr" { description = "Your IP in CIDR form for SSH, e.g. 1.2.3.4/32" }
provider "aws" { region = var.region }

resource "aws_security_group" "fleetpulse" {
  name = "fleetpulse"
  ingress { from_port = 3000 to_port = 3000 protocol = "tcp" cidr_blocks = ["0.0.0.0/0"] }
  ingress { from_port = 22   to_port = 22   protocol = "tcp" cidr_blocks = [var.my_ip_cidr] }
  egress  { from_port = 0    to_port = 0    protocol = "-1"  cidr_blocks = ["0.0.0.0/0"] }
}

resource "aws_instance" "fleetpulse" {
  ami                    = var.ami_id
  instance_type          = "t3.large"
  vpc_security_group_ids = [aws_security_group.fleetpulse.id]
  user_data = <<-EOT
    #!/bin/bash
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs git
    git clone ${var.repo_url} /opt/fleetpulse
    cd /opt/fleetpulse && nohup npm start > /var/log/fleetpulse.log 2>&1 &
  EOT
  tags = { Name = "fleetpulse" }
}
output "url" { value = "http://${aws_instance.fleetpulse.public_ip}:3000" }
