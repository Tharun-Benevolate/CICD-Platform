variable "aws_region" {
  description = "AWS region for the shared foundation stack"
  type        = string
  default     = "us-east-1"
}

variable "foundation_name" {
  description = "Name identifier for shared foundation resources"
  type        = string
  default     = "shared-foundation"
}
